import Link from "next/link";

export default function Unauthorized() {
  return (
    <main data-testid="unauthorized">
      <h1>Sign in to continue</h1>
      <p>This page needs a signed-in account.</p>
      <Link href="/">Choose a demo account</Link>
    </main>
  );
}
