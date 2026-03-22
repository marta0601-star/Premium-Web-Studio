import { useEffect, useRef, useState } from "react";

declare const Quagga: {
  init: (config: unknown, callback: (err: unknown) => void) => void;
  start: () => void;
  stop: () => void;
  onDetected: (callback: (result: QuaggaResult) => void) => void;
  offDetected: (callback: (result: QuaggaResult) => void) => void;
};

interface QuaggaResult {
  codeResult: {
    code: string;
    decodedCodes: { error?: number }[];
  };
}

function isValidEAN(code: string): boolean {
  if (code.length !== 8 && code.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < code.length - 1; i++) {
    const digit = parseInt(code[i]);
    if (code.length === 13) {
      sum += i % 2 === 0 ? digit : digit * 3;
    } else {
      sum += i % 2 === 0 ? digit * 3 : digit;
    }
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(code[code.length - 1]);
}

const PATCH_SIZES = ["medium", "large", "small"] as const;
type PatchSize = typeof PATCH_SIZES[number];

interface BarcodeScannerProps {
  onScan: (text: string) => void;
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const stoppedRef = useRef(false);
  const patchIdxRef = useRef(0);
  const lastDetectRef = useRef(Date.now());
  const rotateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showHint, setShowHint] = useState(false);

  function startQuagga(patchSize: PatchSize, onScanCallback: (code: string) => void) {
    let lastCode = "";
    let readCount = 0;

    function onDetected(result: QuaggaResult) {
      if (stoppedRef.current) return;

      const code = result.codeResult.code;

      // Confidence check
      const errors = result.codeResult.decodedCodes
        .filter((x) => x.error !== undefined)
        .map((x) => x.error as number);
      if (errors.length > 0) {
        const avgError = errors.reduce((a, b) => a + b, 0) / errors.length;
        if (avgError > 0.12) return;
      }

      if (code.length !== 8 && code.length !== 13) return;
      if (!isValidEAN(code)) return;

      // Reset hint timer on any valid candidate
      lastDetectRef.current = Date.now();
      setShowHint(false);

      // Same code 2 times in a row
      if (code === lastCode) {
        readCount++;
        if (readCount >= 2) {
          stoppedRef.current = true;
          if (rotateTimerRef.current) clearInterval(rotateTimerRef.current);
          if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
          Quagga.offDetected(onDetected);
          try { Quagga.stop(); } catch { /* ignore */ }
          if (navigator.vibrate) navigator.vibrate(100);
          onScanCallback(code);
        }
      } else {
        lastCode = code;
        readCount = 1;
      }
    }

    Quagga.init(
      {
        inputStream: {
          name: "Live",
          type: "LiveStream",
          target: document.querySelector("#reader"),
          constraints: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        locator: {
          patchSize,
          halfSample: true,
        },
        decoder: {
          readers: ["ean_reader", "ean_8_reader", "upc_reader", "upc_e_reader"],
        },
        locate: true,
        frequency: 20,
      },
      (err) => {
        if (err) {
          console.error("[Quagga] Init error:", err);
          return;
        }
        if (!stoppedRef.current) {
          Quagga.start();
          Quagga.onDetected(onDetected);
        }
      }
    );
  }

  useEffect(() => {
    stoppedRef.current = false;
    patchIdxRef.current = 0;
    lastDetectRef.current = Date.now();

    startQuagga(PATCH_SIZES[0], (code) => {
      onScanRef.current(code);
    });

    // Every 5 seconds with no valid read → rotate patchSize + show hint
    rotateTimerRef.current = setInterval(() => {
      if (stoppedRef.current) return;
      const elapsed = Date.now() - lastDetectRef.current;
      if (elapsed >= 5000) {
        setShowHint(true);
        // Rotate patchSize
        patchIdxRef.current = (patchIdxRef.current + 1) % PATCH_SIZES.length;
        const nextPatch = PATCH_SIZES[patchIdxRef.current];
        console.log("[Quagga] Rotating patchSize →", nextPatch);
        try { Quagga.stop(); } catch { /* ignore */ }
        startQuagga(nextPatch, (code) => {
          onScanRef.current(code);
        });
        lastDetectRef.current = Date.now();
      }
    }, 5000);

    return () => {
      stoppedRef.current = true;
      if (rotateTimerRef.current) clearInterval(rotateTimerRef.current);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      try { Quagga.stop(); } catch { /* ignore */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-full">
      <div id="reader" />
      {showHint && (
        <p className="mt-2 text-center text-sm text-amber-400/80 font-medium">
          Skúste priblížiť alebo oddialiť telefón
        </p>
      )}
    </div>
  );
}
