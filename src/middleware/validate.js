export const validate = (schema) => (req, _res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return next(failValidation(error));
  req.body = value;
  next();
};
function failValidation(error) { return new Error(error.details.map((d) => d.message).join('; '), { cause: { status: 400, code: 'VALIDATION_ERROR' } }); }
