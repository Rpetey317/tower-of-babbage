#!/usr/bin/env node
/**
 * Word error rate (docs/testing.md "Model checks"):
 *   scripts/wer.mjs <exported.txt> <ground-truth.txt>
 *
 * Normalizes both texts (lowercase, punctuation stripped, whitespace
 * collapsed), then computes WER = (S + D + I) / reference words via a
 * word-level Levenshtein alignment. Prints the rate plus the error counts.
 * Recording tool, not a gate: exits 0 whenever the computation succeeds.
 *
 * Zero dependencies; requires Node >= 18.
 */

import { readFileSync } from "node:fs";

if (process.argv.length !== 4) {
	console.error(`Usage: ${process.argv[1]} <exported.txt> <ground-truth.txt>`);
	process.exit(2);
}

const [hypothesisPath, referencePath] = process.argv.slice(2);

function words(path) {
	const text = readFileSync(path, "utf8");
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

/**
 * Levenshtein alignment of ref -> hyp. Returns {s, d, i}: substitutions,
 * deletions (ref word missing in hyp) and insertions (extra hyp word).
 */
function align(ref, hyp) {
	// dp[i][j]: min edit cost between ref[0..i) and hyp[0..j).
	const dp = Array.from({ length: ref.length + 1 }, () =>
		new Array(hyp.length + 1).fill(0),
	);
	for (let i = 0; i <= ref.length; i++) dp[i][0] = i;
	for (let j = 0; j <= hyp.length; j++) dp[0][j] = j;
	for (let i = 1; i <= ref.length; i++) {
		for (let j = 1; j <= hyp.length; j++) {
			const sub = dp[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
			dp[i][j] = Math.min(sub, dp[i - 1][j] + 1, dp[i][j - 1] + 1);
		}
	}
	// Backtrace from the bottom-right, preferring match/sub over del over ins.
	let i = ref.length;
	let j = hyp.length;
	const counts = { s: 0, d: 0, i: 0 };
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
			i--;
			j--;
		} else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
			counts.s++;
			i--;
			j--;
		} else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
			counts.d++;
			i--;
		} else {
			counts.i++;
			j--;
		}
	}
	return counts;
}

const ref = words(referencePath);
const hyp = words(hypothesisPath);

if (ref.length === 0) {
	console.log(
		hyp.length === 0
			? "WER: 0.00% (both texts empty)"
			: "WER: undefined (empty reference, non-empty hypothesis)",
	);
	process.exit(0);
}

const { s, d, i } = align(ref, hyp);
const wer = (s + d + i) / ref.length;

console.log(`WER: ${(wer * 100).toFixed(2)}% (${s + d + i}/${ref.length})`);
console.log(`  substitutions: ${s}, deletions: ${d}, insertions: ${i}`);
console.log(`  reference words: ${ref.length}, hypothesis words: ${hyp.length}`);
