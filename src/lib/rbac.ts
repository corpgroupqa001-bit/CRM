// Roles and permissions. The source of truth is the database: role_permissions (migrations 0018/0019),
// checked by RLS and by has_perm() in every protected function. The app loads the signed-in user's
// permissions from the server (my_access) on each request and uses them only to decide what to
// show; it never sends a role or permission to the server.
// super_admin is not a company role: my_access reports it for a platform operator acting in a company
export type Role = "owner" | "company_admin" | "hr" | "finance" | "manager" | "employee" | "super_admin";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner", company_admin: "Administrator", hr: "HR Manager", finance: "Finance / Payroll", manager: "Manager", employee: "Employee",
  super_admin: "Super Admin",
};

/** roles an administrator can assign (the owner is fixed; super admin is platform-level, not a company role) */
export const ASSIGNABLE_ROLES: Role[] = ["company_admin", "hr", "finance", "manager", "employee"];

export type Perm =
  | "employees.create" | "employees.read_all" | "employees.read_team" | "employees.update" | "employees.delete"
  | "employees.account" | "employees.assign_role" | "employees.pay_fields"
  | "attendance.read_all" | "attendance.read_team" | "attendance.manage" | "attendance.approve" | "attendance.unlock"
  | "salaries.read" | "salaries.manage" | "salaries.approve"
  | "tasks.use" | "tasks.read_all" | "tasks.read_team" | "tasks.manage" | "tasks.manage_all"
  | "projects.use" | "projects.create" | "projects.manage_all"
  | "chat.use" | "announcements.post" | "settings.manage" | "settings.org" | "audit.read" | "leave.manage"
  | "feature.leave";

export type Perms = ReadonlySet<string>;

/** Leave Management is outside Phase 1: on only when the operator enables it in platform_features (reported as feature.leave). */
export const leaveEnabled = (p: Perms) => p.has("feature.leave");

export type NavItem = { href: string; label: string; icon: string; group: string; show: (p: Perms) => boolean };

export const NAV_GROUPS = ["Overview", "My work", "Collaboration", "People & payroll", "Administration"];

const has = (...need: Perm[]) => (p: Perms) => need.some((n) => p.has(n));

export const NAV: NavItem[] = [
  { href: "dashboard", label: "Dashboard", icon: "LayoutDashboard", group: "Overview", show: () => true },
  { href: "attendance/me", label: "My attendance", icon: "Fingerprint", group: "My work", show: () => true },
  { href: "leave", label: "Leave", icon: "Plane", group: "My work", show: leaveEnabled },
  { href: "tasks", label: "Tasks", icon: "ListChecks", group: "Collaboration", show: has("tasks.use", "tasks.read_all") },
  { href: "chat", label: "Chat", icon: "MessageSquare", group: "Collaboration", show: has("chat.use") },
  { href: "announcements", label: "Announcements", icon: "Megaphone", group: "Collaboration", show: () => true },
  { href: "employees", label: "Employees", icon: "Users", group: "People & payroll", show: has("employees.read_all", "employees.read_team", "employees.pay_fields") },
  { href: "attendance", label: "Attendance", icon: "CalendarCheck", group: "People & payroll", show: has("attendance.read_all", "attendance.read_team") },
  { href: "payroll", label: "Payroll", icon: "IndianRupee", group: "People & payroll", show: has("salaries.read") },
  { href: "settings", label: "Settings", icon: "Settings", group: "Administration", show: has("settings.manage", "settings.org") },
];

/** Which permission each export needs (checked server-side in /api/export). */
export const EXPORT_PERMISSION: Record<string, Perm> = {
  "employee-template": "employees.create",
  employees: "employees.read_all",
  attendance: "attendance.read_all",
  projects: "projects.manage_all",
  chat: "settings.manage",
  form16: "salaries.read",
  "salary-register": "salaries.read",
  "pf-ecr": "salaries.read",
  esi: "salaries.read",
  pt: "salaries.read",
  tds: "salaries.read",
  "ctc-vs-actual": "salaries.read",
  "department-cost": "salaries.read",
  journal: "salaries.manage",
  "bank-file": "salaries.manage",   // full account numbers: Finance / Administrator only
};
