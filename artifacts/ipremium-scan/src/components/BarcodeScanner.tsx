import { useEffect, useRef } from "react";

// QuaggaJS is loaded via CDN script tag in index.html
declare const Quagga: {
  init: (config: unknown, callback: (err: unknown) => void) => void;
  start: () => void;
  stop: () => void;
  onDetected: (callback: (result: { codeResult: { code: string } }) => void) => void;
  offDetected: (callback: unknown) => void;
};

interface BarcodeScannerProps {
  onScan: (text: string) => void;
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;

    function onDetected(result: { codeResult: { code: string } }) {
      const code = result.codeResult.code;
      if (code && code.length >= 8 && !stoppedRef.current) {
        stoppedRef.current = true;
        Quagga.stop();
        if (navigator.vibrate) navigator.vibrate(100);
        onScanRef.current(code);
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
