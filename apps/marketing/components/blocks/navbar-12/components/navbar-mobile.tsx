'use client';

import { MenuIcon } from 'lucide-react';

import { Button } from '@permdock/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@permdock/ui/components/dropdown-menu';

import { NAVBAR_COMPANIES, NAVBAR_PRODUCTS, NAVBAR_TOP_LEVEL } from './data';

export function NavbarMobile() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open menu"
          />
        }
      >
        <MenuIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          {NAVBAR_TOP_LEVEL.map((item) => (
            <DropdownMenuItem key={item.href} render={<a href={item.href} />}>
              {item.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Product</DropdownMenuLabel>
          {NAVBAR_PRODUCTS.map((item) => (
            <DropdownMenuItem key={item.href} render={<a href={item.href} />}>
              {item.icon}
              {item.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Resources</DropdownMenuLabel>
          {NAVBAR_COMPANIES.map((item) => (
            <DropdownMenuItem key={item.href} render={<a href={item.href} />}>
              {item.icon}
              {item.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
