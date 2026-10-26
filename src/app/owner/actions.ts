"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { attempt } from "@/lib/actions";

// COM-01: companies are created only by the platform Super Admin (/admin, migration 0020)

// COM-09: archive keeps data for the retention period
export async function setCompanyStatus(companyId: string, status: "active" | "archived") {
  return attempt(async () => {
    const supabase = await createClient();
    const { error } = await supabase.from("companies")
      .update({ status, archived_at: status === "archived" ? new Date().toISOString() : null }).eq("id", companyId);
    if (error) throw error;
    revalidatePath("/owner");
    return status === "archived" ? "Company archived." : "Company restored.";
  });
}
