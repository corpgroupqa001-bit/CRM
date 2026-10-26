"use client";
import { useState } from "react";
import { Field } from "@/components/ui";

type Option = { id: string; name: string };

/**
 * Department first, then designation: the designation list stays disabled until a department is
 * chosen, shows only that department's designations, and is cleared when the department changes.
 * The server checks the pair again (submit_join_request, sa_assign_company), so this is convenience,
 * not the rule.
 */
export function DepartmentDesignation({ departments, designations, designationHint, names = { department: "department", designation: "designation" },
  initial, required = true }: {
  departments: Option[];
  designations: (Option & { department_id: string | null })[];
  designationHint?: string;
  names?: { department: string; designation: string };
  initial?: { department?: string | null; designation?: string | null };
  required?: boolean;
}) {
  const [department, setDepartment] = useState(initial?.department ?? "");
  const [designation, setDesignation] = useState(initial?.designation ?? "");
  const choices = designations.filter((d) => d.department_id === department);

  return (
    <>
      <Field label="Department">
        <select className="input" name={names.department} required={required} value={department}
          onChange={(e) => { setDepartment(e.target.value); setDesignation(""); }}>
          <option value="" disabled={required}>{departments.length ? (required ? "Choose your department" : "—") : "This company has no departments open yet"}</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      <Field label="Designation" hint={designationHint}>
        <select className="input disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400" name={names.designation} required={required}
          disabled={!department} value={designation} onChange={(e) => setDesignation(e.target.value)}>
          <option value="" disabled={required}>{department ? (required ? "Choose your designation" : "—") : "Choose a department first"}</option>
          {choices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
    </>
  );
}
