import { useEffect, useRef, useState, useCallback } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { Camera, Flashlight, FlashlightOff, SwitchCamera, Scan } from "lucide-react";
import { cn } from "@/lib/utils";

const ELEMENT_ID = "qr-reader-canvas";

const BARCODE_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.CODE_39,
  Html5QrcodeSupportedFormats.CODE_93,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
];

function playBeep() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(1400, ctx.currentTime);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.18);
  } catch { /* Audio not supported */ }
}

function vibrate() {
  if ("vibrate" in navigator) {
    try { navigator.vibrate(80); } catch { /* ignore */ }
  }
}

type CameraDevice = { id: string; label: string };

const SCAN_CONFIG = {
  fps: 30,
  qrbox: { width: 340, height: 190 },
  aspectRatio: 1.777,
  videoConstraints: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    advanced: [{ focusMode: "continuous" }] as never,
  },
  experimentalFeatures: { useBarCodeDetectorIfSupported: true },
} as never;

interface BarcodeScannerProps {
  onScan: (text: string) => void;
  className?: string;
}

export function BarcodeScanner({ onScan, className }: BarcodeScannerProps) {
  const [status, setStatus] = useState<"loading" | "scanning" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const [activeCameraIdx, setActiveCameraIdx] = useState(0);

  const html5QrRef = useRef<Html5Qrcode | null>(null);
  const startedRef = useRef(false);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const getOrCreateScanner = useCallback(() => {
    if (!html5QrRef.current) {
      html5QrRef.current = new Html5Qrcode(ELEMENT_ID, {
        verbose: false,
        formatsToSupport: BARCODE_FORMATS,
      });
    }
    return html5QrRef.current;
  }, []);

  const stopScanner = useCallback(async () => {
    if (html5QrRef.current && startedRef.current) {
      try { await html5QrRef.current.stop(); } catch { /* ignore */ }
      startedRef.current = false;
    }
  }, []);

  const onSuccess = useCallback((decodedText: string) => {
    playBeep();
    vibrate();
    onScanRef.current(decodedText);
  }, []);

  const detectTorchSupport = useCallback(() => {
    try {
      const stream = (html5QrRef.current as unknown as { mediaStream?: MediaStream })?.mediaStream;
      if (stream) {
        const [track] = stream.getVideoTracks();
        const caps = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
        setTorchSupported(!!(caps?.torch));
        return;
      }
    } catch { /* ignore */ }
    setTorchSupported(false);
  }, []);

  const startWithConstraints = useCallback(async (cameraConstraint: { deviceId?: { exact: string }; facingMode?: string }) => {
    const scanner = getOrCreateScanner();
    await scanner.start(
      cameraConstraint,
      SCAN_CONFIG,
      onSuccess,
      () => { /* silent scan errors */ }
    );
    startedRef.current = true;
    setStatus("scanning");
    detectTorchSupport();
  }, [getOrCreateScanner, onSuccess, detectTorchSupport]);

  const startScanner = useCallback(async (camList: CameraDevice[], camIdx: number) => {
    await stopScanner();
    setStatus("loading");

    const cameraId = camList[camIdx]?.id;

    try {
      // Try exact deviceId first (best for multi-camera phones)
      if (cameraId) {
        await startWithConstraints({ deviceId: { exact: cameraId } });
        return;
      }
    } catch {
      // Fall through to facingMode fallback
    }

    try {
      // Fallback: environment (back camera)
      await startWithConstraints({ facingMode: "environment" });
    } catch {
      try {
        // Last resort: any camera
        await startWithConstraints({ facingMode: "user" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Nie można uruchomić kamery";
        setErrorMsg(msg);
        setStatus("error");
      }
    }
  }, [stopScanner, startWithConstraints]);

  const toggleTorch = useCallback(async () => {
    if (!html5QrRef.current || !startedRef.current) return;
    const next = !torchOn;
    try {
      await html5QrRef.current.applyVideoConstraints({
        advanced: [{ torch: next }] as never,
      });
      setTorchOn(next);
    } catch { /* torch not supported at runtime */ }
  }, [torchOn]);

  const switchCamera = useCallback(async () => {
    if (cameras.length < 2) return;
    const nextIdx = (activeCameraIdx + 1) % cameras.length;
    setActiveCameraIdx(nextIdx);
    setTorchOn(false);
    await startScanner(cameras, nextIdx);
  }, [cameras, activeCameraIdx, startScanner]);

  // Mount: enumerate cameras and start
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const camList = await Html5Qrcode.getCameras();
        if (cancelled) return;

        if (!camList || camList.length === 0) {
          // No cameras found via enumeration — try facingMode directly
          await startScanner([], 0);
          return;
        }

        // Prefer back/environment camera
        let preferredIdx = camList.findIndex(
          (c) => /back|rear|environment|tylna|główna/i.test(c.label)
        );
        if (preferredIdx < 0) {
          preferredIdx = camList.findIndex(
            (c) => !/front|selfie|przednia|user/i.test(c.label)
          );
        }
        if (preferredIdx < 0) preferredIdx = camList.length > 1 ? 1 : 0; // index 1 is usually back on Android

        if (!cancelled) {
          setCameras(camList);
          setActiveCameraIdx(preferredIdx);
          await startScanner(camList, preferredIdx);
        }
      } catch {
        if (cancelled) return;
        // getCameras() failed — try environment facingMode directly
        await startScanner([], 0);
      }
    })();

    return () => {
      cancelled = true;
      stopScanner().then(() => {
        html5QrRef.current = null;
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={cn(
      "relative w-full max-w-sm mx-auto rounded-2xl overflow-hidden bg-black border border-white/10 shadow-2xl",
      className
    )}>
      {/* Top control bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-black/80 backdrop-blur-sm border-b border-white/10 z-20 relative">
        <div className="flex items-center gap-2">
          <Scan className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-xs font-semibold text-white/60 tracking-wide">
            {status === "loading" && "Uruchamianie…"}
            {status === "scanning" && "Skanuję…"}
            {status === "error" && "Błąd kamery"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {torchSupported && (
            <button
              type="button"
              onClick={toggleTorch}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-all",
                torchOn
                  ? "bg-yellow-400/20 text-yellow-300 border-yellow-400/40"
                  : "bg-white/10 text-white/50 border-white/10 hover:bg-white/20 hover:text-white/80"
              )}
              title={torchOn ? "Wyłącz latarkę" : "Użyj latarki"}
            >
              {torchOn
                ? <Flashlight className="w-3.5 h-3.5" />
                : <FlashlightOff className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{torchOn ? "Latarka ON" : "Latarka"}</span>
            </button>
          )}
          {cameras.length > 1 && (
            <button
              type="button"
              onClick={switchCamera}
              className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/10 text-white/50 border border-white/10 hover:bg-white/20 hover:text-white/80 transition-all text-xs font-medium"
              title="Przełącz kamerę"
            >
              <SwitchCamera className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Kamera</span>
            </button>
          )}
        </div>
      </div>

      {/* Video area */}
      <div className="relative bg-black" style={{ minHeight: 260 }}>
        {/* html5-qrcode video mounts here */}
        <div id={ELEMENT_ID} className="w-full" />

        {/* Loading overlay */}
        {status === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-10">
            <Camera className="w-10 h-10 text-primary/40 animate-pulse mb-3" />
            <p className="text-sm text-white/40 font-medium">Uruchamianie aparatu…</p>
          </div>
        )}

        {/* Error overlay */}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 z-10 p-6 text-center">
            <Camera className="w-9 h-9 text-red-400/60 mb-3" />
            <p className="text-sm text-red-300 font-medium leading-relaxed">
              {errorMsg || "Nie można uruchomić kamery"}
            </p>
            <p className="mt-2 text-xs text-white/30">Skorzystaj z pola ręcznego poniżej</p>
          </div>
        )}

        {/* Laser scan line — overlays the viewfinder when scanning */}
        {status === "scanning" && (
          <div className="absolute inset-0 pointer-events-none z-10 flex items-center justify-center">
            <div className="relative" style={{ width: 340, maxWidth: "90%", height: 190 }}>
              {/* Corner brackets */}
              <span className="absolute top-0 left-0 w-7 h-7 border-t-2 border-l-2 border-primary rounded-tl" />
              <span className="absolute top-0 right-0 w-7 h-7 border-t-2 border-r-2 border-primary rounded-tr" />
              <span className="absolute bottom-0 left-0 w-7 h-7 border-b-2 border-l-2 border-primary rounded-bl" />
              <span className="absolute bottom-0 right-0 w-7 h-7 border-b-2 border-r-2 border-primary rounded-br" />
              {/* Animated red laser line */}
              <div className="laser-line absolute left-3 right-3 h-px bg-gradient-to-r from-transparent via-red-500 to-transparent shadow-[0_0_8px_2px_rgba(239,68,68,0.5)]" />
            </div>
          </div>
        )}
      </div>

      {/* Bottom hint */}
      <div className="px-4 py-2 bg-black/80 border-t border-white/10 text-center">
        <p className="text-xs text-white/35 font-medium">
          {status === "scanning" && "Nakieruj aparat na kod kreskowy EAN"}
          {status === "loading" && "Proszę czekać…"}
          {status === "error" && "Sprawdź uprawnienia kamery w przeglądarce"}
        </p>
      </div>
    </div>
  );
}
