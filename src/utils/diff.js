import { truncateOutput } from "./security.js";

function lcsMatrix(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  return matrix;
}

export function createUnifiedDiff(oldText, newText, filePath, { maxChars = 2600 } = {}) {
  if (oldText === newText) return "Tidak ada perubahan isi file.";

  const oldLines = String(oldText ?? "").split(/\r?\n/);
  const newLines = String(newText ?? "").split(/\r?\n/);

  if (oldLines.length * newLines.length > 250000) {
    return truncateOutput(
      [
        `--- ${filePath}`,
        `+++ ${filePath}`,
        `File terlalu besar untuk diff rinci.`,
        `Baris lama: ${oldLines.length}`,
        `Baris baru: ${newLines.length}`
      ].join("\n"),
      maxChars
    );
  }

  const matrix = lcsMatrix(oldLines, newLines);
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (j < newLines.length && (i === oldLines.length || matrix[i][j + 1] >= matrix[i + 1]?.[j])) {
      lines.push(`+ ${newLines[j]}`);
      j += 1;
    } else if (i < oldLines.length) {
      lines.push(`- ${oldLines[i]}`);
      i += 1;
    }

    if (lines.join("\n").length > maxChars * 1.4) break;
  }

  return truncateOutput(lines.join("\n"), maxChars);
}
