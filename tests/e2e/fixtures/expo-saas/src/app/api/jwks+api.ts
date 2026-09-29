import { saasJwks } from 'permdock/testing/saas';

export function GET(): Response {
  return Response.json(saasJwks);
}
