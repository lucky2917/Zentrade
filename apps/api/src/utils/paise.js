const toPaise = (rupees) => Math.round(rupees * 100);

const toRupees = (paise) => paise / 100;

export { toPaise, toRupees };

/*
 * tiny helper to convert between rupees and paise. we store all
 * money as integers (paise) in the db to avoid floating point
 * issues. tradingEngine and squareOff both use these.
 */
