import { describe, expect, it } from "vitest";
import { rupeesInWords } from "@/lib/format";

describe("net pay in words (SAL-20)", () => {
  it("uses Indian numbering", () => {
    expect(rupeesInWords(28549)).toBe("Rupees Twenty Eight Thousand Five Hundred Forty Nine Only");
    expect(rupeesInWords(1250000)).toBe("Rupees Twelve Lakh Fifty Thousand Only");
    expect(rupeesInWords(31000000)).toBe("Rupees Three Crore Ten Lakh Only");
    expect(rupeesInWords(0)).toBe("Rupees Zero Only");
  });
});

describe("errorMessage: database checks become plain sentences", () => {
  it("names the field instead of the constraint", async () => {
    const { errorMessage } = await import("../src/lib/actions");
    expect(errorMessage({ code: "23514", message: 'new row for relation "employees" violates check constraint "employees_phone_format"' }))
      .toBe("The mobile number isn't valid. Use digits only, e.g. 98480 22338.");
    expect(errorMessage({ code: "23514", message: 'new row for relation "x" violates check constraint "x_other"' })).toBe("Some of the details aren't valid. Check them and try again.");
    expect(errorMessage({ code: "23514", message: "Work from home isn't enabled for this employee; ask HR" })).toBe("Work from home isn't enabled for this employee; ask HR");
  });
});
