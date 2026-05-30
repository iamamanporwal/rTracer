/**
 * Back-compat shim for the car controller.
 *
 * The vehicle system was refactored into the modular movement framework under
 * `./movement`. `createVehicle` is now an alias for the car controller; the
 * types (`VehicleHandle`, `VehicleSnapshot`, …) are exported from
 * `./movement/types`. This keeps the public `@trace/physics` surface — and the
 * existing session, renderer, and tests — unchanged.
 */
export { createCarController as createVehicle } from './movement/car/controller';
