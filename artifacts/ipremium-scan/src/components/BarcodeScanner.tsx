import { useEffect, useRef } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";

interface CameraDevice {
  id: string;
  label: string;
}

function pickMainRearCamera(cameras: CameraDevice[]): CameraDevice | null {
  if (cameras.length === 0) return null;

  const FRONT = /front|predná|user|selfie|facetime/i;
  const BAD   = /wide|ultra|dual|tele|macro|široko|duálna|dualna/i;
  const REAR  = /back|rear|zadná|tylna|rückkamera|caméra arrière/i;

  // 1. Remove front cameras
  const rear = cameras.filter((c) => !FRONT.test(c.label));
  const pool = rear.length > 0 ? rear : cameras;

  // 2. BEST: rear camera whose label contains a rear keyword but NO bad keyword
  const clean = pool.filter((c) => REAR.test(c.label) && !BAD.test(c.label));
  if (clean.length > 0) {
    // Pick shortest label among clean matches (shortest = most generic = main camera)
    clean.sort((a, b) => a.label.length - b.label.length);
    console.log("[Scanner] Selected (clean rear):", clean[0].label);
    return clean[0];
  }

  // 3. OK: shortest label that contains a rear keyword (even if bad words present)
  const rearAny = pool.filter((c) => REAR.test(c.label));
  if (rearAny.length > 0) {
    rearAny.sort((a, b) => a.label.length - b.label.length);
    console.log("[Scanner] Selected (shortest rear):", rearAny[0].label);
    return rearAny[0];
  }

  // 4. FALLBACK: last camera in the full pool (main rear is usually listed last)
  const last = pool[pool.length - 1];
  console.log("[Scanner] Selected (fallback last):", last.label);
  return last;
}

interface BarcodeScannerProps {
  onScan: (text: string) => void;
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let scanner: Html5Qrcode | null = null;

    Html5Qrcode.getCameras()
      .then((cameras) => {
        console.log(
          "[Scanner] All cameras:",
          cameras.map((c) => `"${c.label}"`).join(", ")
        );

        const chosen = pickMainRearCamera(cameras);

        scanner = new Html5Qrcode("reader");

        const cameraArg = chosen
          ? { deviceId: { exact: chosen.id } }
          : { facingMode: "environment" };

        return scanner.start(
          cameraArg,
          {
            fps: 10,
            qrbox: { width: 250, height: 150 },
            formatsToSupport: [
              Html5QrcodeSupportedFormats.EAN_13,
              Html5QrcodeSupportedFormats.EAN_8,
              Html5QrcodeSupportedFormats.UPC_A,
              Html5QrcodeSupportedFormats.UPC_E,
              Html5QrcodeSupportedFormats.CODE_128,
              Html5QrcodeSupportedFormats.CODE_39,
            ],
          },
          (decodedText) => {
            onScanRef.current(decodedText);
          },
          () => {}
        );
      })
      .catch((err) => {
        console.error("[Scanner] Camera error:", err);
      });

    return () => {
      if (scanner) scanner.stop().catch(() => {});
    };
  }, []);

  return <div id="reader" className="w-full" />;
}
