import { useEffect, useRef, useState } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";

interface CameraDevice {
  id: string;
  label: string;
}

interface BarcodeScannerProps {
  onScan: (text: string) => void;
}

function pickMainCamera(cameras: CameraDevice[]): CameraDevice {
  const BAD = /wide|ultra|dual|macro|tele/i;

  // Exclude front-facing cameras first
  const rear = cameras.filter((c) => !/front|selfie|user|przednia/i.test(c.label));
  const pool = rear.length > 0 ? rear : cameras;

  // Prefer cameras whose label does NOT contain bad keywords
  const good = pool.filter((c) => !BAD.test(c.label));
  if (good.length > 0) return good[0];

  // Fall back to first rear camera
  return pool[0];
}

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const [cameraList, setCameraList] = useState<CameraDevice[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<CameraDevice | null>(null);

  useEffect(() => {
    let scanner: Html5Qrcode | null = null;
    let stopped = false;

    Html5Qrcode.getCameras()
      .then((cameras) => {
        console.log(
          "[Scanner] Available cameras:",
          cameras.map((c) => `"${c.label}" (id=${c.id})`).join(", ")
        );
        setCameraList(cameras);

        const chosen = cameras.length > 0 ? pickMainCamera(cameras) : null;
        setSelectedCamera(chosen);

        console.log(
          "[Scanner] Selected camera:",
          chosen ? `"${chosen.label}" (id=${chosen.id})` : "none — falling back to facingMode"
        );

        scanner = new Html5Qrcode("reader");

        const cameraArg = chosen ? { deviceId: { exact: chosen.id } } : { facingMode: "environment" };

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
      stopped = true;
      if (scanner) scanner.stop().catch(() => {});
      void stopped;
    };
  }, []);

  return (
    <div className="w-full">
      <div id="reader" className="w-full" />

      {/* Camera debug list — temporary, shows on screen */}
      {cameraList.length > 0 && (
        <div className="mt-2 p-2 rounded bg-black/60 text-xs text-white/60 space-y-1">
          <p className="font-semibold text-white/80 mb-1">Dostępne kamery:</p>
          {cameraList.map((cam) => (
            <p key={cam.id} className={cam.id === selectedCamera?.id ? "text-green-400 font-bold" : ""}>
              {cam.id === selectedCamera?.id ? "✓ " : "  "}
              {cam.label || "(bez nazwy)"} <span className="opacity-40 text-[10px]">{cam.id.slice(0, 16)}…</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
