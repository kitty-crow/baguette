import ts from "typescript";
import { required } from "./required.ts";

/** Materialise a named, typed parameter without manufacturing an absent token. */
export function nativeParameter(name: string | ts.BindingName, type: ts.TypeNode): ts.ParameterDeclaration {
  const file = ts.createSourceFile("parameter.ts", "function f(slot: SlotType) {}", ts.ScriptTarget.Latest, true);
  const declaration = required(file.statements[0] ?? null, "parameter template");
  if (!ts.isFunctionDeclaration(declaration)) throw new Error("Invalid parameter template");
  const parameter = required(declaration.parameters[0] ?? null, "parameter");
  const result = ts.transform(parameter, [context => root => ts.visitEachChild(root, node => {
    if (node === parameter.name) return typeof name === "string" ? ts.factory.createIdentifier(name) : name;
    if (node === (parameter.type ?? null)) return type;
    return node;
  }, context)]);
  try {
    return ts.setTextRange(required(result.transformed[0] ?? null, "parameter transform"), {pos: -1, end: -1});
  } finally { result.dispose(); }
}
