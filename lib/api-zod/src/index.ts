export * from "./generated/api";

// NOTE: CreateOfferResponse is intentionally excluded from this list — it
// collides with the zod schema of the same name in ./generated/api, which
// is the canonical export (it can be both .parse()d at runtime and used as
// a type via z.infer<typeof CreateOfferResponse>). When orval generates
// new types, add them here.
//
// Real root cause is the orval config emitting both a zod schema AND a
// separate interface for the same name; see follow-up TODO.
export type {
  CategoryParameter,
  CategoryParameterRestrictions,
  CategoryParameterType,
  CreateOfferRequest,
  ErrorResponse,
  HealthStatus,
  LookupProductParams,
  LookupResult,
  ParameterOption,
  ParameterValue,
  Ping200,
  ProductImage,
  ScanEanParams,
  ScanResult,
  ScanResultPrefillValues,
} from "./generated/types";
