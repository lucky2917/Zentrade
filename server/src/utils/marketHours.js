// M1: NSE trading holidays — update this set each year.
// Source: NSE India official holiday list (https://www.nseindia.com).
const NSE_HOLIDAYS = new Set([
    // 2025
    "2025-01-26", // Republic Day
    "2025-03-14", // Holi
    "2025-04-14", // Dr. Ambedkar Jayanti
    "2025-04-18", // Good Friday
    "2025-05-01", // Maharashtra Day
    "2025-08-15", // Independence Day
    "2025-10-02", // Gandhi Jayanti
    "2025-10-20", // Diwali Laxmi Puja (Muhurat trading day varies — mark closed)
    "2025-10-22", // Diwali Balipratipada
    "2025-11-05", // Gurunanak Jayanti
    "2025-12-25", // Christmas
    // 2026
    "2026-01-26", // Republic Day
    "2026-02-19", // Chhatrapati Shivaji Maharaj Jayanti (Maharashtra)
    "2026-03-03", // Holi (tentative)
    "2026-04-03", // Good Friday
    "2026-04-14", // Dr. Ambedkar Jayanti
    "2026-05-01", // Maharashtra Day
    "2026-08-15", // Independence Day
    "2026-10-02", // Gandhi Jayanti
    "2026-11-09", // Diwali Laxmi Puja (tentative)
    "2026-11-10", // Diwali Balipratipada (tentative)
    "2026-11-24", // Gurunanak Jayanti (tentative)
    "2026-12-25", // Christmas
]);

const isMarketOpen = () => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);

    const day = ist.getDay();
    if (day === 0 || day === 6) return false;

    const dateStr = `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;
    if (NSE_HOLIDAYS.has(dateStr)) return false;

    const hours = ist.getHours();
    const minutes = ist.getMinutes();
    const timeInMinutes = hours * 60 + minutes;

    const marketOpen = 9 * 60 + 15;
    const marketClose = 15 * 60 + 30;

    return timeInMinutes >= marketOpen && timeInMinutes <= marketClose;
};

export { isMarketOpen, NSE_HOLIDAYS };
