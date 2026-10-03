import { NavbarActions } from './navbar-actions';
import { NavbarRepo } from './navbar-repo';

export function Navbar() {
  return (
    <header className="border-border bg-background/80 sticky top-0 z-20 flex h-14 w-full shrink-0 items-center justify-between gap-2 border-b px-4 backdrop-blur">
      <NavbarRepo />
      <NavbarActions />
    </header>
  );
}
