/** Physical constants (SI). See SPEC.md "Physics model". */
export const RHO = 1.2; // kg/m³
export const CP = 1005; // J/(kg·K)
export const G = 9.81; // m/s²
export const KELVIN = 273.15;

/** Effective (turbulent) viscosity, m²/s. Tunable; real air is far smaller. */
export const NU_EFF_DEFAULT = 0.005;
/** Effective turbulent Prandtl number: alpha_eff = nu_eff / PR_EFF. */
export const PR_EFF = 0.85;
