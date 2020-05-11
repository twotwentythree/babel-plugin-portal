// Based on https://github.com/zeit/next.js/blob/canary/packages/next/build/babel/plugins/next-ssg-transform.ts

import pathLib from 'path'

import { NodePath, PluginObj, parse } from '@babel/core'
import * as BabelTypes from '@babel/types'

export const EXPORT_NAME_GET_STATIC_PROPS = 'getStaticProps'
export const EXPORT_NAME_GET_STATIC_PATHS = 'getStaticPaths'
export const EXPORT_NAME_GET_SERVER_PROPS = 'getServerSideProps'

const ssgExports = new Set([
  EXPORT_NAME_GET_STATIC_PROPS,
  EXPORT_NAME_GET_STATIC_PATHS,
  EXPORT_NAME_GET_SERVER_PROPS,

  // legacy methods added so build doesn't fail from importing
  // server-side only methods
  `unstable_getStaticProps`,
  `unstable_getStaticPaths`,
  `unstable_getServerProps`,
	`unstable_getServerSideProps`,
])

type PluginState = {
  refs: Set<NodePath<BabelTypes.Identifier>>
	portalIdentifierName: Set<string>
	cwd: string
	filename: string,
	opts?: {
		portals?: string[]
	}
}

export default function nextTransformSsg({
  types: t,
}: {
	types: typeof BabelTypes
}): PluginObj<PluginState> {
  function getIdentifier(
    path: NodePath<
      | BabelTypes.FunctionDeclaration
      | BabelTypes.FunctionExpression
      | BabelTypes.ArrowFunctionExpression
    >
  ): NodePath<BabelTypes.Identifier> | null {
    const parentPath = path.parentPath
    if (parentPath.type === 'VariableDeclarator') {
      const pp = parentPath as NodePath<BabelTypes.VariableDeclarator>
      const name = pp.get('id')
      return name.node.type === 'Identifier'
        ? (name as NodePath<BabelTypes.Identifier>)
        : null
    }

    if (parentPath.type === 'AssignmentExpression') {
      const pp = parentPath as NodePath<BabelTypes.AssignmentExpression>
      const name = pp.get('left')
      return name.node.type === 'Identifier'
        ? (name as NodePath<BabelTypes.Identifier>)
        : null
    }

    if (path.node.type === 'ArrowFunctionExpression') {
      return null
    }

    return path.node.id && path.node.id.type === 'Identifier'
      ? (path.get('id') as NodePath<BabelTypes.Identifier>)
      : null
  }

  function isIdentifierReferenced(
    ident: NodePath<BabelTypes.Identifier>
  ): boolean {
    const b = ident.scope.getBinding(ident.node.name)
    return b != null && b.referenced
  }

  function markFunction(
    path: NodePath<
      | BabelTypes.FunctionDeclaration
      | BabelTypes.FunctionExpression
      | BabelTypes.ArrowFunctionExpression
    >,
    state: PluginState
  ) {
    const ident = getIdentifier(path)
		if (ident?.node && isIdentifierReferenced(ident)) {
      state.refs.add(ident)
    }
  }

  function markImport(
    path: NodePath<
      | BabelTypes.ImportSpecifier
      | BabelTypes.ImportDefaultSpecifier
      | BabelTypes.ImportNamespaceSpecifier
    >,
    state: PluginState
  ) {
		const local = path.get('local')

		if (path.node.type === 'ImportDefaultSpecifier' && path.parent.type === 'ImportDeclaration') {
			const sourceValue = path.parent.source.value
			if (['/', '../', './'].some(x => sourceValue.startsWith(x))) {
				const importFullPath = pathLib.resolve(pathLib.dirname(state.filename), removeFileExt(sourceValue))

				const isPortal = state.opts?.portals?.some(x => pathLib.join(state.cwd, removeFileExt(x)) === importFullPath)

				if (local.node.name === 'useQueryFactory') {
					console.log(importFullPath, state.cwd, state.opts?.portals)
				}

				if (isPortal) {
					state.portalIdentifierName.add(local.node.name)
					console.log(local.node.name)
				}
			}
		}

    if (isIdentifierReferenced(local)) {
      state.refs.add(local)
    }
  }

  return {
    visitor: {
      Program: {
        enter(_path, state) {
          state.refs = new Set<NodePath<BabelTypes.Identifier>>()
          state.portalIdentifierName = new Set<string>()
        },
        exit(path, state) {
          const refs = state.refs
          let count: number

          function sweepFunction(
            path: NodePath<
              | BabelTypes.FunctionDeclaration
              | BabelTypes.FunctionExpression
              | BabelTypes.ArrowFunctionExpression
            >
          ) {
            const ident = getIdentifier(path)
            if (
              ident?.node &&
              refs.has(ident) &&
              !isIdentifierReferenced(ident)
            ) {
              ++count

              if (
                t.isAssignmentExpression(path.parentPath) ||
                t.isVariableDeclarator(path.parentPath)
              ) {
                path.parentPath.remove()
              } else {
                path.remove()
              }
            }
          }

          function sweepImport(
            path: NodePath<
              | BabelTypes.ImportSpecifier
              | BabelTypes.ImportDefaultSpecifier
              | BabelTypes.ImportNamespaceSpecifier
            >
          ) {
            const local = path.get('local')
            if (refs.has(local) && !isIdentifierReferenced(local)) {
              ++count
              path.remove()
              if (
                (path.parent as BabelTypes.ImportDeclaration).specifiers
                  .length === 0
              ) {
                path.parentPath.remove()
              }
            }
					}

					path.traverse<PluginState>({
						CallExpression(path, state) {
							const ident = getIdentifier(path);

							const calleeIdent = path.get('callee')



							if (state.portalIdentifierName.has(calleeIdent.node.name)) {
								path.replaceWith(t.callExpression(
									t.memberExpression(t.identifier(calleeIdent.node.name), t.identifier('register')),
									[
										t.stringLiteral(pathLib.relative(state.cwd, removeFileExt(state.filename))),
										t.stringLiteral(ident.get('name').node)
									]
								))
							}
						},
					}, state)

          do {
            ;(path.scope as any).crawl()
            count = 0

            path.traverse({
              // eslint-disable-next-line no-loop-func
              VariableDeclarator(path) {
                if (path.node.id.type !== 'Identifier') {
                  return
                }

                const local = path.get('id') as NodePath<BabelTypes.Identifier>
                if (refs.has(local) && !isIdentifierReferenced(local)) {
                  ++count
                  path.remove()
                }
              },
              FunctionDeclaration: sweepFunction,
              FunctionExpression: sweepFunction,
              ArrowFunctionExpression: sweepFunction,
              ImportSpecifier: sweepImport,
              ImportDefaultSpecifier: sweepImport,
							ImportNamespaceSpecifier: sweepImport,
            })
          } while (count)
        },
      },
      VariableDeclarator(path, state) {
        if (path.node.id.type !== 'Identifier') {
          return
        }

        const local = path.get('id') as NodePath<BabelTypes.Identifier>
        if (isIdentifierReferenced(local)) {
          state.refs.add(local)
        }
      },
      FunctionDeclaration: markFunction,
      FunctionExpression: markFunction,
      ArrowFunctionExpression: markFunction,
      ImportSpecifier: markImport,
      ImportDefaultSpecifier: markImport,
			ImportNamespaceSpecifier: markImport,
    },
  }
}

function removeFileExt(fileName: string): string {
	const parsed = pathLib.parse(fileName)

	return pathLib.join(parsed.dir, parsed.name)
}
