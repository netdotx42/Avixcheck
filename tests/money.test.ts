import { describe, expect, it } from "vitest";
import { Decimal, dec, decOrNull, round, roundMoney, sum, toFixed } from "../src/lib/money/decimal";
import { withinTolerance } from "../src/lib/money/tolerance";

describe("decimal arithmetic", () => {
  it("avoids binary float errors", () => {
    expect(dec("0.1").plus(dec("0.2")).equals(dec("0.3"))).toBe(true);
    expect(sum([dec("19.99"), dec("0.01"), dec("80.00")]).toFixed(2)).toBe("100.00");
  });

  it("rejects JS numbers and junk", () => {
    // @ts-expect-error numbers are deliberately not accepted
    expect(() => dec(0.1)).toThrow(TypeError);
    expect(() => dec("1e5")).toThrow(RangeError);
    expect(() => dec("NaN")).toThrow(RangeError);
    expect(() => dec("")).toThrow(RangeError);
    expect(decOrNull("  ")).toBeNull();
  });

  it("applies explicit rounding modes", () => {
    expect(round(dec("2.345"), 2, "half_up").toFixed(2)).toBe("2.35");
    expect(round(dec("2.345"), 2, "half_even").toFixed(2)).toBe("2.34");
    expect(round(dec("-2.345"), 2, "half_up").toFixed(2)).toBe("-2.35");
    expect(round(dec("2.341"), 2, "up").toFixed(2)).toBe("2.35");
    expect(round(dec("2.349"), 2, "down").toFixed(2)).toBe("2.34");
    expect(toFixed(dec("10"), 4)).toBe("10.0000");
  });

  it("rounds to currency minor units", () => {
    expect(roundMoney(dec("1234.5"), "JPY", "half_up").toFixed()).toBe("1235");
    expect(roundMoney(dec("1.2345"), "KWD", "half_up").toFixed()).toBe("1.235");
    expect(roundMoney(dec("1.235"), "GBP", "half_even").toFixed()).toBe("1.24");
  });

  it("handles large values exactly", () => {
    const big = dec("999999999999.9999").times(dec("1000"));
    expect(big.toFixed(4)).toBe("999999999999999.9000");
    expect(big instanceof Decimal).toBe(true);
  });
});

describe("tolerances", () => {
  it("passes within absolute tolerance", () => {
    expect(withinTolerance(dec("10.00"), dec("10.01"), { absolute: "0.01", percent: "0" })).toBe(true);
    expect(withinTolerance(dec("10.00"), dec("10.02"), { absolute: "0.01", percent: "0" })).toBe(false);
  });
  it("passes within percentage tolerance", () => {
    expect(withinTolerance(dec("200"), dec("202"), { absolute: "0", percent: "1" })).toBe(true);
    expect(withinTolerance(dec("200"), dec("202.01"), { absolute: "0", percent: "1" })).toBe(false);
  });
  it("is exact with zero tolerances and zero expected", () => {
    expect(withinTolerance(dec("0"), dec("0.0001"), { absolute: "0", percent: "5" })).toBe(false);
    expect(withinTolerance(dec("5"), dec("5"), { absolute: "0", percent: "0" })).toBe(true);
  });
});
