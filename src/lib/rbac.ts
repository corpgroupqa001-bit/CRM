// Roles and permissions (BRD v2.0 §5.3). The source of truth is the database: role_permissions (migrations 0018/0019/0027),
// checked by RLS and by has_perm() in every protected function. The app loads the signed-in user's
// permissions from the server (my_access) on each request and uses them only to decide what to
// show; it never sends a role or permission to the server.
// super_admin is not a company role: my_access reports it for a platform operator acting in a company
export type Role = "owner" | "company_admin" | "hr" | "manager" | "employee" | "super_admin";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner", company_admin: "Administrator", hr: "HR Manager", manager: "Manager", employee: "Employee",
  super_admin: "Super Admin",
};

/** roles an administrator can assign (the owner is fixed; super admin is platform-level, not a company role) */
export const ASSIGNABLE_ROLES: Role[] = ["company_admin", "hr", "manager", "employee"];

export type Perm =
  | "employees.create" | "employees.read_all" | "employees.read_team" | "employees.update" | "employees.delete"
  | "employees.account" | "employees.assign_role" | "employees.pay_fields"
  | "attendance.read_all" | "attendance.read_team" | "attendance.manage" | "attendance.approve" | "attendance.unlock"
  | "salaries.read" | "salaries.manage" | "salaries.approve"
  | "tasks.use" | "tasks.read_all" | "tasks.read_team" | "tasks.manage" | "tasks.manage_all" | "tasks.create_own"
  | "projects.use" | "projects.read_all" | "projects.lead" | "projects.manage_all"
  | "chat.use" | "announcements.post" | "company.update" | "settings.read" | "settings.manage" | "settings.org" | "audit.read" | "leave.manage"
  | "roles.manage" | "feature.leave";

export type Perms = ReadonlySet<string>;

/** Custom roles (BRD §5.2): every permission an Owner or Company Admin can tick, grouped by module, in plain words. */
export const PERMISSION_GROUPS: { module: string; perms: [Perm, string][] }[] = [
  { module: "Employees", perms: [
    ["employees.read_all", "See all employees"], ["employees.read_team", "See their own team"],
    ["employees.create", "Add employees"], ["employees.update", "Edit employee details"], ["employees.delete", "Remove employees"],
    ["employees.pay_fields", "See and edit PAN, bank and pay details"], ["employees.account", "Send invitations and manage logins"],
    ["employees.assign_role", "Change people's roles"]] },
  { module: "Attendance & leave", perms: [
    ["attendance.read_all", "See everyone's attendance"], ["attendance.read_team", "See their team's attendance"],
    ["attendance.manage", "Correct attendance, manage devices and WFH"], ["attendance.approve", "Approve corrections and leave"],
    ["attendance.unlock", "Unlock a locked month"], ["leave.manage", "Manage leave types and balances"]] },
  { module: "Payroll", perms: [
    ["salaries.read", "See salaries and payroll"], ["salaries.manage", "Prepare payroll and salary structures"],
    ["salaries.approve", "Approve and lock payroll"]] },
  { module: "Tasks", perms: [
    ["tasks.use", "Use tasks"], ["tasks.create_own", "Create tasks for themselves"], ["tasks.read_team", "See their team's tasks"],
    ["tasks.read_all", "See all tasks"], ["tasks.manage", "Create and assign tasks"], ["tasks.manage_all", "Edit anyone's tasks"]] },
  { module: "Projects", perms: [
    ["projects.use", "Use projects they belong to"], ["projects.lead", "Manage projects they lead"],
    ["projects.read_all", "See all projects"], ["projects.manage_all", "Create and manage all projects"]] },
  { module: "Communication", perms: [["chat.use", "Use chat"], ["announcements.post", "Post announcements"]] },
  { module: "Company & settings", perms: [
    ["company.update", "Edit the company profile"], ["settings.read", "See settings"],
    ["settings.manage", "Change settings, devices and support access"], ["settings.org", "Edit departments, designations and holidays"],
    ["roles.manage", "Manage roles"], ["audit.read", "See the audit log"]] },
];

/** Leave Management (ATT-17 to 19): on per platform_features, reported as feature.leave (on since 0027). */
export const leaveEnabled = (p: Perms) => p.has("feature.leave");

export type NavItem = { href: string; label: string; icon: string; group: string; show: (p: Perms) => boolean };

export const NAV_GROUPS = ["Overview", "My work", "Collaboration", "People & payroll", "Administration"];

const has = (...need: Perm[]) => (p: Perms) => need.some((n) => p.has(n));

export const NAV: NavItem[] = [
  { href: "dashboard", label: "Dashboard", icon: "LayoutDashboard", group: "Overview", show: () => true },
  { href: "attendance/me", label: "My attendance", icon: "Fingerprint", group: "My work", show: () => true },
  { href: "leave", label: "Leave", icon: "Plane", group: "My work", show: leaveEnabled },
  { href: "payslips", label: "My payslips", icon: "Receipt", group: "My work", show: () => true },
  { href: "tasks", label: "Tasks", icon: "ListChecks", group: "Collaboration", show: has("tasks.use", "tasks.read_all") },
  { href: "chat", label: "Chat", icon: "MessageSquare", group: "Collaboration", show: has("chat.use") },
  { href: "announcements", label: "Announcements", icon: "Megaphone", group: "Collaboration", show: () => true },
  { href: "employees", label: "Employees", icon: "Users", group: "People & payroll", show: has("employees.read_all", "employees.read_team", "employees.pay_fields") },
  { href: "attendance", label: "Attendance", icon: "CalendarCheck", group: "People & payroll", show: has("attendance.read_all", "attendance.read_team") },
  { href: "payroll", label: "Payroll", icon: "IndianRupee", group: "People & payroll", show: has("salaries.read") },
  { href: "settings", label: "Settings", icon: "Settings", group: "Administration", show: has("settings.read") },
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
  "bank-file": "salaries.manage",   // full account numbers: HR / Payroll, who prepares and pays
};
