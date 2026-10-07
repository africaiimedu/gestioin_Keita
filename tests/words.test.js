import assert from "node:assert/strict";
import { test } from "node:test";
import { amountInWords } from "../src/finance/words.js";

const cases = [
  [0, "zéro franc guinéen"],
  [1, "un franc guinéen"],
  [2, "deux francs guinéens"],
  [16, "seize francs guinéens"],
  [17, "dix-sept francs guinéens"],
  [21, "vingt et un francs guinéens"],
  [70, "soixante-dix francs guinéens"],
  [71, "soixante et onze francs guinéens"],
  [80, "quatre-vingts francs guinéens"],
  [81, "quatre-vingt-un francs guinéens"],
  [91, "quatre-vingt-onze francs guinéens"],
  [100, "cent francs guinéens"],
  [101, "cent un francs guinéens"],
  [180, "cent quatre-vingts francs guinéens"],
  [200, "deux cents francs guinéens"],
  [201, "deux cent un francs guinéens"],
  [1_000, "mille francs guinéens"],
  [1_080, "mille quatre-vingts francs guinéens"],
  [1_800, "mille huit cents francs guinéens"],
  [80_000, "quatre-vingt mille francs guinéens"],
  [200_000, "deux cent mille francs guinéens"],
  [1_000_000, "un million de francs guinéens"],
  [2_000_000, "deux millions de francs guinéens"],
  [3_500_000, "trois millions cinq cent mille francs guinéens"],
  [4_000_000, "quatre millions de francs guinéens"],
  [21_000_000, "vingt et un millions de francs guinéens"],
  [21_500_000, "vingt et un millions cinq cent mille francs guinéens"],
  [23_800_000, "vingt-trois millions huit cent mille francs guinéens"],
  [25_000_000, "vingt-cinq millions de francs guinéens"],
  [30_000_000, "trente millions de francs guinéens"],
  [37_000_000, "trente-sept millions de francs guinéens"],
  [80_000_000, "quatre-vingts millions de francs guinéens"],
  [200_000_000, "deux cents millions de francs guinéens"],
  [1_000_000_000, "un milliard de francs guinéens"],
];

test("montant en lettres sur plus de 30 valeurs", () => {
  assert.ok(cases.length >= 30);
  for (const [amount, words] of cases) {
    assert.equal(amountInWords(amount), words, String(amount));
  }
});

test("un montant à virgule est refusé", () => {
  assert.throws(() => amountInWords(10.5));
});
