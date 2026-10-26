// The company switcher lists only companies this person can open: an active membership, and not an
// inactive, exited or removed employee record there (the same rule my_access applies on every request).
type Membership = { role: string; companies: unknown };
type MyRecord = { company_id: string; status: string; removed_at: string | null };

export function switcherCompanies(memberships: Membership[] | null, myRecords: MyRecord[] | null) {
  const closed = new Set((myRecords ?? []).filter((r) => r.removed_at || r.status === "inactive" || r.status === "exited").map((r) => r.company_id));
  return (memberships ?? []).map((m) => {
    const c = m.companies as { id: string; name: string };
    return { id: c.id, name: c.name, role: m.role };
  }).filter((c) => !closed.has(c.id));
}
