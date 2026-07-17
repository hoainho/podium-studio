import { describe, it, expect } from "vitest";
import { foldText, textMatches, textContains } from "../shared/text-fold.ts";

// Spec E6 AC4: >=10 diacritic/case/whitespace pairs, 100% pass rate.
const matchingPairs: Array<[string, string]> = [
  ["Đăng nhập", "dang nhap"],
  ["ĐĂNG NHẬP", "đăng nhập"],
  ["  Đăng   nhập  ", "Đăng nhập"],
  ["Cài đặt", "cai dat"],
  ["Người dùng", "nguoi dung"],
  ["Kiểm thử", "kiem thu"],
  ["Podium Studio", "podium   studio"],
  ["Xin chào", "XIN CHAO"],
  ["Thất bại", "that bai"],
  ["Đã kết nối", "da ket noi"],
  ["Trình mô phỏng", "trinh mo phong"],
];

const nonMatchingPairs: Array<[string, string]> = [
  ["Đăng nhập", "Đăng ký"],
  ["Kiểm thử", "Kiểm tra"],
];

describe("text-fold — Vietnamese/Unicode-safe matching (E6 AC4)", () => {
  it.each(matchingPairs)("textMatches('%s', '%s') is true", (a, b) => {
    expect(textMatches(a, b)).toBe(true);
  });

  it.each(nonMatchingPairs)("textMatches('%s', '%s') is false (distinct words)", (a, b) => {
    expect(textMatches(a, b)).toBe(false);
  });

  it("folds diacritics, case, and whitespace independently of order applied", () => {
    expect(foldText("ĐĂNG NHẬP")).toBe("dang nhap");
    expect(foldText("  dang   nhap ")).toBe("dang nhap");
  });

  it("is idempotent — folding an already-folded string is a no-op", () => {
    const folded = foldText("Đăng nhập thành công");
    expect(foldText(folded)).toBe(folded);
  });

  it("textContains finds a folded needle inside a folded haystack (assert text / tapText path)", () => {
    expect(textContains("Đăng nhập thành công", "thanh cong")).toBe(true);
    expect(textContains("Đăng nhập thành công", "ĐĂNG NHẬP")).toBe(true);
    expect(textContains("Đăng nhập thành công", "dang xuat")).toBe(false);
  });
});
