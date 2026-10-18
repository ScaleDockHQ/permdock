"use client";

import type { Choice } from "permdock/preset";

import { Checkbox } from "@permdock/ui/components/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@permdock/ui/components/field";
import {
  RadioGroup,
  RadioGroupItem,
} from "@permdock/ui/components/radio-group";
import { Badge } from "@permdock/ui/reui/badge";
import { IconTile } from "@permdock/ui/reui/icon-tile";

import { choiceMedia } from "./choice-media";

const NONE: readonly never[] = [];

function live<T extends string>(choices: readonly Choice<T>[]) {
  return choices.filter((choice) => choice.retired !== true);
}

function CardBody<T extends string>({
  choice,
  badge,
}: {
  readonly choice: Choice<T>;
  readonly badge?: string;
}) {
  return (
    <>
      <IconTile variant="outline" size="sm">
        {choiceMedia(choice.id)}
      </IconTile>
      <FieldContent>
        <FieldTitle>
          {choice.title}
          {badge === undefined ? null : (
            <Badge variant="secondary">{badge}</Badge>
          )}
        </FieldTitle>
        <FieldDescription>{choice.description}</FieldDescription>
      </FieldContent>
    </>
  );
}

export function RadioCards<T extends string>({
  name,
  label,
  choices,
  value,
  onChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly choices: readonly Choice<T>[];
  readonly value: T;
  readonly onChange: (next: T) => void;
}) {
  const options = live(choices);
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      className="grid gap-3 sm:grid-cols-2"
      onValueChange={(next) => {
        const match = options.find((choice) => choice.id === next);
        if (match !== undefined) {
          onChange(match.id);
        }
      }}
    >
      {options.map((choice) => {
        const id = `${name}-${choice.id}`;
        return (
          <FieldLabel key={choice.id} htmlFor={id}>
            <Field orientation="horizontal">
              <CardBody choice={choice} />
              <RadioGroupItem value={choice.id} id={id} />
            </Field>
          </FieldLabel>
        );
      })}
    </RadioGroup>
  );
}

export function CheckboxCards<T extends string>({
  name,
  label,
  choices,
  value,
  locked = NONE,
  onChange,
}: {
  readonly name: string;
  readonly label: string;
  readonly choices: readonly Choice<T>[];
  readonly value: readonly T[];
  readonly locked?: readonly T[];
  readonly onChange: (next: T[]) => void;
}) {
  const options = live(choices);
  return (
    <fieldset className="grid gap-3 sm:grid-cols-2">
      <legend className="sr-only">{label}</legend>
      {options.map((choice) => {
        const id = `${name}-${choice.id}`;
        const required = locked.includes(choice.id);
        return (
          <FieldLabel key={choice.id} htmlFor={id}>
            <Field orientation="horizontal">
              <CardBody
                choice={choice}
                badge={required ? "Required" : undefined}
              />
              <Checkbox
                id={id}
                checked={value.includes(choice.id)}
                disabled={required}
                onCheckedChange={(checked) => {
                  const next = checked
                    ? [...value, choice.id]
                    : value.filter((item) => item !== choice.id);
                  onChange(
                    options
                      .map((option) => option.id)
                      .filter(
                        (option) =>
                          next.includes(option) || locked.includes(option),
                      ),
                  );
                }}
              />
            </Field>
          </FieldLabel>
        );
      })}
    </fieldset>
  );
}
