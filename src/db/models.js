import { DataTypes } from "sequelize";

// Description des tables pour Sequelize. La structure réelle (contraintes, déclencheurs d'intégrité)
// vient des migrations SQL de src/db/migrations : ne jamais appeler sequelize.sync().

const id = () => ({ type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true });
const ref = (allowNull = false) => ({ type: DataTypes.INTEGER, allowNull });
const text = (allowNull = true) => ({ type: DataTypes.TEXT, allowNull });
const amount = () => ({ type: DataTypes.BIGINT, allowNull: false });
const day = (allowNull = false) => ({ type: DataTypes.DATEONLY, allowNull });
const flag = () => ({ type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 });
// Horodatage rempli par PostgreSQL (DEFAULT) : absent des INSERT tant qu'on ne le fournit pas.
const stamp = () => ({ type: DataTypes.STRING });
const LEVELS = ["licence", "master", "tech", "bachelor", "bachelor_1", "bachelor_2", "bachelor_3", "master_1", "master_2"];
const INSTALLMENTS = ["inscription", "tranche_1", "tranche_2", "tranche_3"];
const METHODS = ["especes", "cheque", "virement", "mobile", "orange_money", "marchand", "autre"];

const tables = () => ({
  Role: ["roles", { id: id(), code: text(false), label: text(false) }],
  User: ["users", {
    id: id(),
    role_id: ref(),
    full_name: text(false),
    email: text(false),
    password_hash: text(false),
    totp_secret: text(),
    totp_required: flag(),
    active: { ...flag(), defaultValue: 1 },
    permissions_json: text(),
    must_change_password: flag(),
    created_at: stamp(),
  }],
  Session: ["sessions", {
    id: { type: DataTypes.TEXT, primaryKey: true },
    user_id: ref(),
    created_at: amount(),
    last_seen: amount(),
    expires_at: amount(),
  }],
  LoginLog: ["login_logs", { id: id(), user_id: ref(true), email: text(), success: flag(), ip: text(), created_at: stamp() }],
  AcademicYear: ["academic_years", { id: id(), label: text(false), starts_on: day(), ends_on: day(), active: flag() }],
  Program: ["programs", { id: id(), code: text(false), name: text(false) }],
  FeeSchedule: ["fee_schedules", {
    id: id(),
    program_id: ref(),
    academic_year_id: ref(),
    level: { type: DataTypes.TEXT, allowNull: false, validate: { isIn: [LEVELS] } },
    tuition_amount: amount(),
    registration_amount: amount(),
    installment_1: amount(),
    installment_2: amount(),
    installment_3: amount(),
    registration_included: { ...flag(), defaultValue: 1 },
    created_at: stamp(),
  }],
  FeeScheduleHistory: ["fee_schedule_history", {
    id: id(), fee_schedule_id: ref(), snapshot_json: text(false), changed_by: ref(true), changed_at: stamp(),
  }],
  InstallmentDueDate: ["installment_due_dates", {
    id: id(), academic_year_id: ref(), code: { type: DataTypes.TEXT, allowNull: false, validate: { isIn: [INSTALLMENTS] } }, due_on: day(),
  }],
  Student: ["students", {
    id: id(),
    matricule: text(false),
    legacy_number: { type: DataTypes.INTEGER },
    last_name: text(false),
    first_name: text(false),
    program_id: ref(),
    academic_year_id: ref(),
    level: { type: DataTypes.TEXT, allowNull: false, validate: { isIn: [LEVELS] } },
    phone: text(),
    email: text(),
    account_email: text(),
    guardian_name: text(),
    guardian_phone: text(),
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: "actif" },
    photo_path: text(),
    card_status: { type: DataTypes.TEXT, allowNull: false, defaultValue: "active" },
    source: { type: DataTypes.TEXT, allowNull: false, defaultValue: "saisie" },
    costume_quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_at: stamp(),
  }],
  Discount: ["discounts", {
    id: id(), student_id: ref(), label: text(false), mode: text(false), value: amount(), reason: text(false), approved_by: ref(true), created_at: stamp(),
  }],
  Adjustment: ["adjustments", { id: id(), student_id: ref(), amount: amount(), reason: text(false), created_by: ref(true), created_at: stamp() }],
  StudentInstallment: ["student_installments", { id: id(), student_id: ref(), code: text(false), amount: amount(), due_on: day(true) }],
  Payment: ["payments", {
    id: id(),
    student_id: ref(),
    amount: amount(),
    paid_on: day(),
    date_unconfirmed: flag(),
    method: { type: DataTypes.TEXT, allowNull: false, validate: { isIn: [METHODS] } },
    reference: text(),
    installment_code: text(),
    note: text(),
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: "valide" },
    idempotency_key: text(false),
    received_by: ref(),
    created_at: stamp(),
  }],
  PaymentControl: ["payment_controls", {
    payment_id: { type: DataTypes.INTEGER, primaryKey: true },
    updates_used: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    cancel_used: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unlocked: flag(),
  }],
  CostumePayment: ["costume_payments", {
    id: id(),
    student_id: ref(),
    payment_id: ref(true),
    amount: amount(),
    paid_on: day(),
    method: text(),
    note: text(),
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: "valide" },
    cancel_reason: text(),
    received_by: ref(),
    created_at: stamp(),
  }],
  PaymentAttachment: ["payment_attachments", {
    id: id(), payment_id: ref(), filename: text(false), stored_path: text(false), mime: text(), uploaded_at: stamp(),
  }],
  DocumentSequence: ["document_sequences", {
    kind: { type: DataTypes.TEXT, primaryKey: true },
    year: { type: DataTypes.INTEGER, primaryKey: true },
    last_number: { type: DataTypes.INTEGER, allowNull: false },
  }],
  Receipt: ["receipts", {
    id: id(),
    payment_id: ref(),
    number: text(false),
    year: { type: DataTypes.INTEGER, allowNull: false },
    seq: { type: DataTypes.INTEGER, allowNull: false },
    verify_token: text(false),
    snapshot_json: text(false),
    print_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: stamp(),
  }],
  EnrollmentReceipt: ["enrollment_receipts", {
    id: id(),
    student_id: ref(),
    number: text(false),
    year: { type: DataTypes.INTEGER, allowNull: false },
    seq: { type: DataTypes.INTEGER, allowNull: false },
    verify_token: text(false),
    snapshot_json: text(false),
    print_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: stamp(),
  }],
  Cancellation: ["cancellations", {
    id: id(), payment_id: ref(), reason: text(false), cancelled_by: ref(), cancelled_at: stamp(), credit_note_number: text(),
  }],
  Reminder: ["reminders", { id: id(), student_id: ref(), channel: text(false), message: text(false), created_by: ref(true), created_at: stamp() }],
  AuditLog: ["audit_logs", {
    id: id(), user_id: ref(true), action: text(false), entity: text(false), entity_id: text(), before_json: text(), after_json: text(), created_at: stamp(),
  }],
  ImportBatch: ["import_batches", { id: id(), filename: text(), status: text(false), report_json: text(false), created_by: ref(true), created_at: stamp() }],
  Setting: ["settings", { key: { type: DataTypes.TEXT, primaryKey: true }, value: text(false) }],
  Expense: ["expenses", {
    id: id(),
    number: text(false),
    year: { type: DataTypes.INTEGER, allowNull: false },
    seq: { type: DataTypes.INTEGER, allowNull: false },
    issued_on: day(),
    city: text(false),
    receiver_name: text(false),
    receiver_position: text(false),
    giver_name: text(false),
    amount: amount(),
    reason: text(false),
    category: { type: DataTypes.TEXT, allowNull: false, defaultValue: "autre" },
    status: { type: DataTypes.TEXT, allowNull: false, defaultValue: "valide" },
    cancel_reason: text(),
    cancelled_by: ref(true),
    cancelled_at: stamp(),
    verify_token: text(false),
    print_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    handed_at: stamp(),
    handed_by: ref(true),
    created_by: ref(),
    created_at: stamp(),
  }],
});

export function defineModels(sequelize) {
  for (const [name, [tableName, attributes]] of Object.entries(tables())) {
    sequelize.define(name, attributes, { tableName });
  }

  const m = sequelize.models;
  const link = { constraints: false };
  m.User.belongsTo(m.Role, { foreignKey: "role_id", as: "role", ...link });
  m.Session.belongsTo(m.User, { foreignKey: "user_id", as: "user", ...link });
  m.Student.belongsTo(m.Program, { foreignKey: "program_id", as: "program", ...link });
  m.Student.belongsTo(m.AcademicYear, { foreignKey: "academic_year_id", as: "academicYear", ...link });
  m.FeeSchedule.belongsTo(m.Program, { foreignKey: "program_id", as: "program", ...link });
  m.FeeSchedule.belongsTo(m.AcademicYear, { foreignKey: "academic_year_id", as: "academicYear", ...link });
  m.Payment.belongsTo(m.Student, { foreignKey: "student_id", as: "student", ...link });
  m.Payment.belongsTo(m.User, { foreignKey: "received_by", as: "receiver", ...link });
  m.Payment.hasOne(m.Receipt, { foreignKey: "payment_id", as: "receipt", ...link });
  m.Payment.hasOne(m.PaymentControl, { foreignKey: "payment_id", as: "control", ...link });
  m.Payment.hasOne(m.Cancellation, { foreignKey: "payment_id", as: "cancellation", ...link });
  m.Student.hasMany(m.Payment, { foreignKey: "student_id", as: "payments", ...link });
  m.Student.hasMany(m.CostumePayment, { foreignKey: "student_id", as: "costumePayments", ...link });
  m.Student.hasMany(m.Reminder, { foreignKey: "student_id", as: "reminders", ...link });
  m.Student.hasOne(m.EnrollmentReceipt, { foreignKey: "student_id", as: "enrollmentReceipt", ...link });
  return m;
}
