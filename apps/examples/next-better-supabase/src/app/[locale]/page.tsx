const people = [
  {
    id: "00000000-0000-4000-8000-0000000000a1",
    name: "Olivia, owner of Acme",
    next: "/en/acme/staff",
  },
  {
    id: "00000000-0000-4000-8000-0000000000a2",
    name: "Mason, member of Acme",
    next: "/en/acme/staff",
  },
  {
    id: "00000000-0000-4000-8000-0000000000a3",
    name: "Carla, portal contact at Initech",
    next: "/en/portal/acme/quotes",
  },
] as const;

/** The `serve` build signs in through `/api/test/sign-in`; a real app uses Supabase Auth. */
export default function Home() {
  return (
    <main>
      <h1>Sign in as</h1>
      <ul>
        {people.map((person) => (
          <li key={person.id}>
            <a
              href={`/api/test/sign-in?user=${person.id}&next=${encodeURIComponent(person.next)}`}
              data-sign-in={person.id}
            >
              {person.name}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
