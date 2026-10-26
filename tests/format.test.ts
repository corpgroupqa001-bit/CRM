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
