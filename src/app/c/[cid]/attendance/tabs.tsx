import { Tabs } from "@/components/ui";
import type { Perms } from "@/lib/rbac";

// Tabs shown by permission: everyone with attendance access sees the daily view and reports;
// approvals for those who approve; devices, shifts and month lock for those who manage attendance.
export function AttendanceTabs({ cid, active, perms }: { cid: string; active: string; perms: Perms }) {
  const b = `/c/${cid}/attendance`;
  const tabs = [
    { key: "daily", label: "Daily", href: b },
    { key: "live", label: "Live", href: `${b}/live` },
    ...(perms.has("attendance.approve") ? [{ key: "requests", label: "Approvals", href: `${b}/requests` }] : []),
    { key: "reports", label: "Reports", href: `${b}/reports` },
    ...(perms.has("attendance.manage") ? [
      { key: "devices", label: "Devices & exceptions", href: `${b}/devices` },
      { key: "shifts", label: "Shifts", href: `${b}/shifts` },
      { key: "lock", label: "Month lock", href: `${b}/lock` },
    ] : []),
  ];
  return <Tabs tabs={tabs} active={active} />;
}
