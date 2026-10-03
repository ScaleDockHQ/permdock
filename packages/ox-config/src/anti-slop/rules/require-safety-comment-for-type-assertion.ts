import type { ESTree, SourceCode } from "@oxlint/plugins";

import { defineRule } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function isSafetyCommentText(value: string): boolean {
  return /\bSAFETY\s*:/u.test(value);
}

function hasAdjacentSafetyComment(
  sourceText: string,
  nodeStart: number,
): boolean {
  let end = nodeStart;
  while (end > 0) {
    const ch = sourceText[end - 1];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "(") {
      end -= 1;
      continue;
    }
    break;
  }

  const prefix = sourceText.slice(0, end);
  const blockComment = /\/\*[\s\S]*?\*\/$/u.exec(prefix);
  if (blockComment && isSafetyCommentText(blockComment[0])) return true;
  const lineComment = /\/\/[^\n]*$/u.exec(prefix);
  return lineComment !== null && isSafetyCommentText(lineComment[0]);
}

function hasSafetyComment(
  sourceCode: SourceCode,
  node: TypeAssertion,
): boolean {
  if (hasAdjacentSafetyComment(sourceCode.text, node.start)) return true;

  let current: ESTree.Node = node;
  while (true) {
    if (
      sourceCode
        .getCommentsBefore(current)
        .some(
          (comment) =>
            comment.end <= node.start && isSafetyCommentText(comment.value),
        )
    ) {
      return true;
    }
    if (
      commentOwnerKinds.has(current.type) ||
      current.parent.type === "Program"
    )
      return false;
    current = current.parent;
  }
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node) || hasSafetyComment(context.sourceCode, node))
        return;
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
