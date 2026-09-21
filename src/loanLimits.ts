// The loan-facts dollar ceiling, mirrored from the server (lambda_api/constants.py
// LOANFACTS_FIELD_MAX). The loan form checks it so a too-large amount gets a friendly
// message before any round-trip, instead of a 400 and the generic save-error toast.
//
// It lives in its own module (WHIT-393) rather than inside app/loan.tsx: the loan-form
// suites derive their at/over-ceiling probes from it, and a screen file is a poor home for
// a value other modules import. tests/lambda_api/test_loanfacts_ceiling_sync.py watches
// THIS file and fails if it stops matching the server.
export const LOANFACTS_FIELD_MAX = 1_000_000_000;
