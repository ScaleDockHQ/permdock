import Link from "next/link";

export default function Forbidden() {
  return (
    <main data-testid="forbidden">
      <h1>You do not have access to this page</h1>
      <p>Ask an organization admin for the role that grants it.</p>
      <Link href="/">Back to the start page</Link>
    </main>
  );
}
