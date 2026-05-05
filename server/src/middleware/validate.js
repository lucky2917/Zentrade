export const required = (v, f) =>
  v === undefined || v === null || v === "" ? `${f} is required` : null;

export const isEmail = (v) =>
  v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim())
    ? "Invalid email format"
    : null;

export const minLength = (n) => (v, f) =>
  v && String(v).length < n ? `${f} must be at least ${n} characters` : null;

export const positiveInt = (v, f) => {
  const n = Number(v);
  return !Number.isInteger(n) || n <= 0
    ? `${f} must be a positive whole number`
    : null;
};

// validate({ email: [required, isEmail], password: [required, minLength(8)] })
export const validate = (schema) => (req, res, next) => {
  for (const [field, rules] of Object.entries(schema)) {
    for (const rule of rules) {
      const error = rule(req.body[field], field);
      if (error) return res.status(400).json({ error });
    }
  }
  next();
};
