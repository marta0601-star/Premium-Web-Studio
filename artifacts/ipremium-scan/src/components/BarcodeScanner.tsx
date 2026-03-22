import { useEffect, useRef, useState } from "react";
import { Html5QrcodeScanner } from "html5-qrcode";
import { Camera } from "lucide-react";
import { cn } from "@/lib/utils";

interface BarcodeScannerProps {
  onScan: (text: string) => void;
  className?: string;
}

export function BarcodeScanner({ onScan, className }: BarcodeScannerProps) {
  const [isInitializing, setIsInitializing] = useState(true);
  const scannerRef = useRef<Html5QrcodeScanner | null>(null);

  useEffect(() => {
    // Delay initialization slightly to ensure DOM is ready and animation finishes
    const timer = setTimeout(() => {
      scannerRef.current = new Html5QrcodeScanner(
        "qr-reader",
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1,
          showTorchButtonIfSupported: true,
        },
        false
      );

      scannerRef.current.render(
        (decodedText) => {
          if (scannerRef.current) {
            scannerRef.current.clear();
          }
          onScan(decodedText);
        },
        (error) => {
          // Silent continuous scanning errors
        }
      );
      
      setIsInitializing(false);
    }, 300);

    return () => {
      clearTimeout(timer);
      if (scannerRef.current) {
        scannerRef.current.clear().catch((e) => console.error("Scanner clear error", e));
      }
    };
  }, [onScan]);

  return (
    <div className={cn("relative w-full max-w-sm mx-auto overflow-hidden rounded-2xl bg-black/40 border border-white/10 shadow-2xl backdrop-blur-md", className)}>
      {isInitializing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 z-10">
          <Camera className="w-8 h-8 text-primary/50 animate-pulse mb-4" />
          <p className="text-sm text-muted-foreground font-medium">Uruchamianie aparatu...</p>
        </div>
      )}
      <div id="qr-reader" className="w-full h-full min-h-[300px]" />
    </div>
  );
}
