import { useEffect, useRef } from "react";

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

interface BarcodeScannerProps {
  onScan: (text: string) => void;
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;

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
        if (avgError > 0.10) return;
      }

      // Must be valid EAN length
      if (code.length !== 8 && code.length !== 13) return;

      // EAN checksum validation
      if (!isValidEAN(code)) return;

      // Same code 3 times in a row
      if (code === lastCode) {
        readCount++;
        if (readCount >= 3) {
          stoppedRef.current = true;
          Quagga.stop();
          if (navigator.vibrate) navigator.vibrate(100);
          onScanRef.current(code);
          lastCode = "";
          readCount = 0;
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
        decoder: {
          readers: ["ean_reader", "ean_8_reader", "upc_reader", "upc_e_reader"],
        },
        locate: true,
        frequency: 10,
      },
      (err) => {
        if (err) {
          console.error("[Quagga] Init error:", err);
          return;
        }
        if (!stoppedRef.current) {
          Quagga.start();
        }
      }
    );

    Quagga.onDetected(onDetected);

    return () => {
      stoppedRef.current = true;
      Quagga.offDetected(onDetected);
      try { Quagga.stop(); } catch { /* ignore */ }
    };
  }, []);

  return <div id="reader" />;
}
