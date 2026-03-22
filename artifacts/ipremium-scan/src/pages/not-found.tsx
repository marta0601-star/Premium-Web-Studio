import { Link } from "wouter";
import { AlertCircle } from "lucide-react";
import { PremiumButton } from "@/components/ui-custom";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background text-foreground p-4">
      <div className="max-w-md w-full text-center space-y-6 bg-black/40 backdrop-blur-xl border border-white/10 p-10 rounded-3xl shadow-2xl">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-destructive/10 mb-2">
          <AlertCircle className="w-10 h-10 text-destructive" />
        </div>
        <h1 className="text-4xl font-display font-bold">404</h1>
        <p className="text-muted-foreground text-lg">
          Nie znaleziono strony. Przepraszamy, ale strona której szukasz nie istnieje.
        </p>
        <Link href="/" className="inline-block pt-4">
          <PremiumButton>Wróc na stronę główną</PremiumButton>
        </Link>
      </div>
    </div>
  );
}
