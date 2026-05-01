import { useCallback, useEffect, useRef, useState } from "react";
import { isValidEAN } from "@/lib/ean";

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

type CameraError = "permission" | "no_camera" | "in_use" | "other";

// getUserMedia error names → human-readable error category. The standard
// MediaError names are stable across browsers; anything else falls into
// "other" so we still show a useful message.
function classifyCameraError(err: unknown): CameraError {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "permission";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "no_camera";
  if (name === "NotReadableError" || name === "TrackStartError") return "in_use";
  return "other";
}

const CAMERA_ERROR_MESSAGES: Record<CameraError, string> = {
  permission: "Povoľte prístup ku kamere v nastaveniach prehliadača a skúste znova.",
  no_camera: "Toto zariadenie nemá dostupnú kameru. Použite manuálny vstup nižšie.",
  in_use: "Kamera je práve používaná inou aplikáciou. Zatvorte ju a skúste znova.",
  other: "Kameru sa nepodarilo spustiť. Skúste obnoviť stránku alebo použite manuálny vstup nižšie.",
};

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
  const [cameraError, setCameraError] = useState<CameraError | null>(null);
  // Bumped by retryCamera to force the boot useEffect to re-run after the
  // user dismisses an error and the #reader div re-mounts.
  const [bootCount, setBootCount] = useState(0);

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
          // getUserMedia / Quagga init failed — surface to the user instead
          // of silently dying. Mark stopped so the patchSize-rotation timer
          // doesn't keep retrying behind the scenes.
          stoppedRef.current = true;
          if (rotateTimerRef.current) clearInterval(rotateTimerRef.current);
          setCameraError(classifyCameraError(err));
          return;
        }
        if (!stoppedRef.current) {
          Quagga.start();
          Quagga.onDetected(onDetected);
        }
      }
    );
  }

  const retryCamera = useCallback(() => {
    setCameraError(null);
    setBootCount((n) => n + 1);
  }, []);

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
  }, [bootCount]);

  if (cameraError) {
    return (
      <div className="w-full p-6 rounded-xl bg-red-500/10 border border-red-500/20 text-center space-y-4">
        <p className="text-sm text-red-400 font-medium">
          {CAMERA_ERROR_MESSAGES[cameraError]}
        </p>
        {cameraError !== "no_camera" && (
          <button
            type="button"
            onClick={retryCamera}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/80 text-sm font-medium hover:bg-white/10 hover:text-white transition-colors"
          >
            Skúsiť znova
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="w-full">
      <div id="reader">
        {/* Visible scan-line overlay — `.laser-line` keyframes already live in
            src/index.css; the absolute/colour utilities here just give the
            element height, position and a primary-tinted hairline so the
            existing animation has something to paint. */}
        <div
          className="laser-line absolute left-0 right-0 h-0.5 bg-primary shadow-[0_0_8px_rgba(255,255,255,0.6)] pointer-events-none z-10"
          aria-hidden
        />
      </div>
      {showHint && (
        <p className="mt-2 text-center text-sm text-amber-400/80 font-medium">
          Skúste priblížiť alebo oddialiť telefón
        </p>
      )}
    </div>
  );
}
