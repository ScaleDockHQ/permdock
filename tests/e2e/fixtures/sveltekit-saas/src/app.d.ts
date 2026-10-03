import type { Session } from "@permdock/e2e-saas-kit";

declare global {
  namespace App {
    interface Locals {
      session: Session | null;
    }
  }
  interface Window {
    saasPausePoll?: boolean;
  }
}
