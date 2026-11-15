export const FONT_SIZE_KEY = "writing-studio:font-size";
export const DEFAULT_FONT_SIZE = 18;
export const MIN_FONT_SIZE = 14;
export const MAX_FONT_SIZE = 24;

export function normalizeFontSize(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number >= MIN_FONT_SIZE && number <= MAX_FONT_SIZE
    ? number
    : DEFAULT_FONT_SIZE;
}

// Percentages keep the browser's own default font preference and zoom effective.
export const fontSizePercentage = (value: number) => `${normalizeFontSize(value) / 16 * 100}%`;

// Apply saved preferences before the page is painted, without a small-text flash.
export const fontSizeBootstrap = `(()=>{try{const v=Number(localStorage.getItem(${JSON.stringify(FONT_SIZE_KEY)}));if(Number.isInteger(v)&&v>=${MIN_FONT_SIZE}&&v<=${MAX_FONT_SIZE})document.documentElement.style.setProperty('--app-font-size',v/16*100+'%')}catch{}})()`;
