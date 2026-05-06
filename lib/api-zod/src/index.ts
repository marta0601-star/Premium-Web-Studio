export * from "./generated/api";

// NOTE: CreateOfferResponse is intentionally excluded from this list — it
// collides with the zod schema of the same name in ./generated/api, which
// is the canonical export (it can be both .parse()d at runtime and used as
// a type via z.infer<typeof CreateOfferResponse>). When orval generates
// new types, add them here.
//
// TODO(api-zod): Fix orval config to not emit duplicate CreateOfferResponse
// (either skip type emit for names with zod schemas, or suffix interface
// version e.g. CreateOfferResponseType). When fixed, this list can revert
// to `export type * from "./generated/types"`.
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
