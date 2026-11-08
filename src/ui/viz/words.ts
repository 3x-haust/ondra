// Calendar words the charts write themselves (month and weekday ticks), in the
// language in use. Called at render time, never at module load.
import { lang } from "../../i18n";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_KO = ["월", "화", "수", "목", "금", "토", "일"];
const DAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** month 1..12 → "3월" / "Mar" */
export const monthWord = (m: number) => (lang() === "en" ? MONTHS[(m - 1 + 12) % 12] : `${m}월`);
/** a year tick → "2026년" / "2026" */
export const yearWord = (y: number) => (lang() === "en" ? `${y}` : `${y}년`);
/** weekday, 0 = Monday … 6 = Sunday → "월" / "Mon" */
export const dayWord = (dow: number) => (lang() === "en" ? DAYS_EN : DAYS_KO)[dow];
/** a month tick that also names the year → "2026.1" / "Jan 2026" */
export const yearMonth = (y: number, m: number) => (lang() === "en" ? `${MONTHS[(m - 1 + 12) % 12]} ${y}` : `${y}.${m}`);
