/** Point d'entrée unique du calcul financier. Ne pas dupliquer ces formules ailleurs. */
export {
  STATUS_LABELS,
  METHOD_LABELS,
  INSTALLMENT_LABELS,
  assertGnf,
  formatGnf,
  percentOf,
  recoveryRate,
  feesDue,
  fitPlanToDue,
  paymentStatus,
  allocate,
  daysBetween,
  agingBucket,
  computeSituation,
  previewSituation,
  officialInstallments,
  REGISTRATION_FEES,
  registrationFee,
} from "./money.js";
export { integerToWords, amountInWords } from "./words.js";
