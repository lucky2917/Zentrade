const toPaise = (rupees) => Math.round(rupees * 100);

const toRupees = (paise) => paise / 100;

export { toPaise, toRupees };
