/**
 * Tests for the hand editor's sentence model. The one promise that matters is
 * that a round trip loses nothing: parse then serialize must give back the
 * same text, marks and all, so opening the editor and saving without a change
 * can never damage a field. Run with `npm test`.
 *
 * Depends on: node:test, ../src/lib/sentence-edit.ts
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  insertAtGap,
  moveBreak,
  parseSentence,
  removeToken,
  serializeSentence,
  toggleHighlight,
  wordCount,
} from "../src/lib/sentence-edit.ts";

const roundTrip = (text: string) => serializeSentence(parseSentence(text));

test("parse then serialize returns the field unchanged", () => {
  for (const text of [
    "/Đạt_được/ điều mong_muốn | sau nhiều cố_gắng bền_bỉ.",
    "Cô ấy làm_việc chăm_chỉ | để=đạt_được ước_mơ trở_thành bác_sĩ.",
    "Chạm tới đích là=gì?",
    "Khi bối_rối, bạn thường tìm ai đó để=hỏi.",
    "Có đủ tiền | để=mua hoặc trả | cho=thứ gì.",
    "Một /bài học/ quý.",
  ]) {
    assert.equal(roundTrip(text), text);
  }
});

test("a clitic bind splits into two chips that rejoin with =", () => {
  const tokens = parseSentence("để=hỏi.");
  assert.equal(wordCount(tokens), 2);
  assert.equal(serializeSentence(tokens), "để=hỏi.");
});

test("a break moves to another gap and is never left at an edge", () => {
  const tokens = parseSentence("Có đủ tiền | để=mua hoặc trả.");
  assert.equal(serializeSentence(moveBreak(tokens, 3, 1)), "Có | đủ tiền để=mua hoặc trả.");
  assert.equal(serializeSentence(moveBreak(tokens, 3, 0)), "Có | đủ tiền để=mua hoặc trả.");
  assert.equal(serializeSentence(moveBreak(tokens, 3, 99)), "Có đủ tiền để=mua hoặc | trả.");
  // A break dropped inside a bind replaces it: the two cannot coexist.
  assert.equal(serializeSentence(moveBreak(tokens, 3, 4)), "Có đủ tiền để | mua hoặc trả.");
});

test("tapping a word toggles its highlight, and adjacent highlights share a marker", () => {
  let tokens = parseSentence("Một bài học quý.");
  tokens = toggleHighlight(tokens, 1);
  tokens = toggleHighlight(tokens, 2);
  assert.equal(serializeSentence(tokens), "Một /bài học/ quý.");
  assert.equal(serializeSentence(toggleHighlight(tokens, 1)), "Một bài /học/ quý.");
});

test("deleting a word keeps the sentence's final punctuation", () => {
  const tokens = parseSentence("Có đủ tiền | để=mua.");
  assert.equal(serializeSentence(removeToken(tokens, 5)), "Có đủ tiền | để.");
  assert.equal(serializeSentence(removeToken(tokens, 4)), "Có đủ tiền | mua.");
  assert.equal(serializeSentence(removeToken(tokens, 3)), "Có đủ tiền để=mua.");
});

test("deleting the only word after a break drops the break and keeps the full stop", () => {
  const tokens = parseSentence("Có đủ tiền | mua.");
  assert.equal(serializeSentence(removeToken(tokens, 4)), "Có đủ tiền.");
});

test("typed text lands in the chosen gap, before the final full stop", () => {
  const tokens = parseSentence("Có đủ tiền.");
  assert.equal(serializeSentence(insertAtGap(tokens, 1, "rất")), "Có rất đủ tiền.");
  assert.equal(serializeSentence(insertAtGap(tokens, 3, "để=mua")), "Có đủ tiền để=mua.");
  assert.equal(serializeSentence(insertAtGap(tokens, 2, "|")), "Có đủ | tiền.");
});
