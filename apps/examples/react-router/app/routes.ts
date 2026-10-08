import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/permdock", "routes/api.permdock.ts"),
  route("health", "routes/health.ts"),
] satisfies RouteConfig;
