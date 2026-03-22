import { useMutation } from "@tanstack/react-query";
import { scanEan, createOffer } from "@workspace/api-client-react";
import type { CreateOfferRequest, ScanResult, ErrorResponse } from "@workspace/api-client-react";

export function useScanBarcode() {
  return useMutation<ScanResult, ErrorResponse, string>({
    mutationFn: async (ean: string) => {
      // Using the raw fetch function directly to trigger on-demand rather than auto-fetching
      return await scanEan({ ean });
    },
  });
}

export function useSubmitOffer() {
  return useMutation<any, ErrorResponse, CreateOfferRequest>({
    mutationFn: async (data: CreateOfferRequest) => {
      return await createOffer(data);
    },
  });
}
