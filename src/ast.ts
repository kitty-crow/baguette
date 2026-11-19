import ts from "typescript";
import { required } from "./required.ts";

type AstReplacement = ts.Node | readonly ts.Node[];
type ModifierList = readonly ts.ModifierLike[];

function statement(text: string): ts.Statement {
  const file = ts.createSourceFile("template.ts", text, ts.ScriptTarget.Latest, false);
  return required(file.statements[0] ?? null, "syntax template");
}

/** Preserve the syntax tree's absent tokens while replacing only supplied children. */
function substitute<T extends ts.Node>(template: T, replacements: ReadonlyMap<ts.Node, AstReplacement>): T {
  const result = ts.transform(template, [context => root =>
    ts.visitEachChild(root, node => replacements.get(node) ?? node, context)]);
  try {
    return ts.setTextRange(required(result.transformed[0] ?? null, "syntax transform"), {pos: -1, end: -1});
  } finally { result.dispose(); }
}

function nameNode(name: string | ts.BindingName | ts.PropertyName): ts.BindingName | ts.PropertyName {
  return typeof name === "string" ? ts.factory.createIdentifier(name) : name;
}

interface ParameterParts {
  readonly name: string | ts.BindingName;
  readonly type: ts.TypeNode;
  readonly modifiers: ModifierList;
  readonly rest: boolean;
  readonly optional: boolean;
  readonly initializer: ts.Expression | null;
}

function parameterFrom(parts: ParameterParts): ts.ParameterDeclaration {
  const declaration = statement("function f(" + (parts.modifiers.length ? "public " : "") + (parts.rest ? "..." : "") +
    "slot" + (parts.optional ? "?" : "") + ": SlotType" + (parts.initializer ? " = slotValue" : "") + ") {}");
  if (!ts.isFunctionDeclaration(declaration)) throw new Error("Invalid parameter template");
  const parameter = required(declaration.parameters[0] ?? null, "parameter");
  const replacements = new Map<ts.Node, AstReplacement>([
    [parameter.name, nameNode(parts.name)], [required(parameter.type ?? null, "parameter type"), parts.type],
  ]);
  if (parts.modifiers.length) replacements.set(required((parameter.modifiers ?? [])[0] ?? null, "modifier"), parts.modifiers);
  if (parts.initializer) replacements.set(required(parameter.initializer ?? null, "parameter initialiser"), parts.initializer);
  return substitute(parameter, replacements);
}

/** Create a typed native parameter with no rest marker or default. */
export function nativeParameter(name: string | ts.BindingName, type: ts.TypeNode): ts.ParameterDeclaration {
  return parameterFrom({name, type, modifiers: [], rest: false, optional: false, initializer: null});
}

export function nativeVariable(name: ts.BindingName, type: ts.TypeNode, initializer: ts.Expression | null, definite = false): ts.VariableDeclaration {
  const declaration = statement("let slot" + (definite ? "!" : "") + ": SlotType" + (initializer ? " = slotValue" : "") + ";");
  if (!ts.isVariableStatement(declaration)) throw new Error("Invalid variable template");
  const template = required(declaration.declarationList.declarations[0] ?? null, "variable");
  const replacements = new Map<ts.Node, AstReplacement>([[template.name, name], [required(template.type ?? null, "variable type"), type]]);
  if (initializer) replacements.set(required(template.initializer ?? null, "variable initialiser"), initializer);
  return substitute(template, replacements);
}

interface PropertyParts {
  readonly name: string | ts.PropertyName;
  readonly type: ts.TypeNode;
  readonly modifiers: ModifierList;
  readonly marker: "" | "?" | "!";
  readonly initializer: ts.Expression | null;
}
function classMember(text: string): ts.ClassElement {
  const declaration = statement("class SlotClass {" + text + "}");
  if (!ts.isClassDeclaration(declaration)) throw new Error("Invalid class template");
  return required(declaration.members[0] ?? null, "class member");
}
function propertyFrom(parts: PropertyParts): ts.PropertyDeclaration {
  const template = classMember((parts.modifiers.length ? "public " : "") + "slot" + parts.marker +
    ": SlotType" + (parts.initializer ? " = slotValue" : "") + ";");
  if (!ts.isPropertyDeclaration(template)) throw new Error("Invalid property template");
  const replacements = new Map<ts.Node, AstReplacement>([[template.name, nameNode(parts.name)], [required(template.type ?? null, "property type"), parts.type]]);
  if (parts.initializer) replacements.set(required(template.initializer ?? null, "property initialiser"), parts.initializer);
  if (parts.modifiers.length) replacements.set(required((template.modifiers ?? [])[0] ?? null, "modifier"), parts.modifiers);
  return substitute(template, replacements);
}
/** Generated frame fields are either initialised immediately or by the constructor. */
export function nativeProperty(name: string, type: ts.TypeNode, initializer: ts.Expression | null): ts.PropertyDeclaration {
  return propertyFrom({name, type, initializer, modifiers: [], marker: initializer ? "" : "!"});
}

type Callable = ts.FunctionDeclaration | ts.FunctionExpression | ts.MethodDeclaration | ts.GetAccessorDeclaration;
export interface NativeCallableParts {
  readonly form: "function" | "expression" | "method" | "getter";
  readonly name: ts.PropertyName | null;
  readonly modifiers: ModifierList;
  readonly typeParameters: readonly ts.TypeParameterDeclaration[];
  readonly parameters: readonly ts.ParameterDeclaration[];
  readonly returns: ts.TypeNode | null;
  readonly body: ts.Block | null;
  readonly question: boolean;
  readonly generator: boolean;
}
function functionTemplate(text: string): ts.FunctionDeclaration {
  const node = statement(text);
  if (!ts.isFunctionDeclaration(node)) throw new Error("Invalid function template");
  return node;
}
function expressionTemplate(text: string): ts.FunctionExpression {
  const node = statement(text);
  if (!ts.isVariableStatement(node)) throw new Error("Invalid expression template");
  const value = required(node.declarationList.declarations[0] ?? null, "function expression").initializer ?? null;
  if (!value || !ts.isFunctionExpression(value)) throw new Error("Invalid function expression");
  return value;
}
function callableTemplate(parts: NativeCallableParts): Callable {
  // A parsed grammar template preserves genuine absence of annotation, name and body.
  const name = parts.name ? "slot" : "";
  const typeParams = parts.typeParameters.length ? "<SlotType>" : "";
  const parameters = parts.form === "getter" ? "()" : "(slotArg: SlotType)";
  const signature = name + (parts.question ? "?" : "") + typeParams + parameters + (parts.returns ? ": SlotType" : "");
  const body = parts.body ? " {}" : ";";
  const star = parts.generator ? "*" : "";
  const prefix = parts.modifiers.length ? "export " : "";
  if (parts.form === "function") return functionTemplate(prefix + "function" + star + " " + signature + body);
  if (parts.form === "expression") return expressionTemplate("const fn = " + (parts.modifiers.length ? "async " : "") + "function" + star + " " + signature + " {};");
  const member = classMember((parts.modifiers.length ? "public " : "") + (parts.form === "getter" ? "get " : star) + signature + body);
  if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) return member;
  throw new Error("Invalid callable member");
}
export function nativeCallable(parts: NativeCallableParts): Callable {
  const template = callableTemplate(parts);
  const replacements = new Map<ts.Node, AstReplacement>();
  if (parts.name) replacements.set(required(template.name ?? null, "callable name"), parts.name);
  if (parts.parameters.length || template.parameters.length) replacements.set(required(template.parameters[0] ?? null, "callable parameter"), parts.parameters);
  if (parts.modifiers.length) replacements.set(required((template.modifiers ?? [])[0] ?? null, "modifier"), parts.modifiers);
  if (parts.typeParameters.length) replacements.set(required((template.typeParameters ?? [])[0] ?? null, "generic parameter"), parts.typeParameters);
  if (parts.returns) replacements.set(required(template.type ?? null, "return type"), parts.returns);
  if (parts.body) replacements.set(required(template.body ?? null, "callable body"), parts.body);
  return substitute(template, replacements);
}
export function nativeFunction(parts: Omit<NativeCallableParts, "form" | "question" | "generator">): ts.FunctionDeclaration {
  const node = nativeCallable({...parts, form: "function", question: false, generator: false});
  if (!ts.isFunctionDeclaration(node)) throw new Error("Expected function declaration");
  return node;
}
export function nativeMethod(parts: Omit<NativeCallableParts, "form" | "generator">): ts.MethodDeclaration {
  const node = nativeCallable({...parts, form: "method", generator: false});
  if (!ts.isMethodDeclaration(node)) throw new Error("Expected method declaration");
  return node;
}
function callableParts(node: Callable, returns: ts.TypeNode | null, modifiers: ModifierList): NativeCallableParts {
  const form = ts.isFunctionDeclaration(node) ? "function" : ts.isFunctionExpression(node) ? "expression" : ts.isMethodDeclaration(node) ? "method" : "getter";
  return {form, name: node.name ?? null, modifiers, typeParameters: node.typeParameters ?? [], parameters: node.parameters,
    returns, body: node.body ?? null, question: ts.isMethodDeclaration(node) && Boolean(node.questionToken ?? null),
    generator: !ts.isGetAccessorDeclaration(node) && Boolean(node.asteriskToken ?? null)};
}
export function annotateCallable(node: Callable, returns: ts.TypeNode | null, modifiers: ModifierList): Callable {
  return ts.setOriginalNode(ts.setTextRange(nativeCallable(callableParts(node, returns, modifiers)), node), node);
}
export function annotateBinding(node: ts.ParameterDeclaration | ts.PropertyDeclaration | ts.VariableDeclaration, type: ts.TypeNode): ts.Node {
  // The original names and initialisers remain the bound nodes used by the checker.
  const initializer = node.initializer ?? null;
  if (ts.isVariableDeclaration(node)) return ts.setOriginalNode(ts.setTextRange(nativeVariable(node.name, type, initializer, Boolean(node.exclamationToken ?? null)), node), node);
  const modifiers = node.modifiers ?? [];
  if (ts.isParameter(node)) return ts.setOriginalNode(ts.setTextRange(parameterFrom({name: node.name, type, modifiers, initializer, optional: Boolean(node.questionToken ?? null), rest: Boolean(node.dotDotDotToken ?? null)}), node), node);
  const marker = node.questionToken ?? null ? "?" : node.exclamationToken ?? null ? "!" : "";
  return ts.setOriginalNode(ts.setTextRange(propertyFrom({name: node.name, type, modifiers, initializer, marker}), node), node);
}
