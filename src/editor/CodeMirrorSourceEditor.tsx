import { useEffect, useRef, type MutableRefObject, type ReactElement } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState } from '@codemirror/state'
import { placeholder as codeMirrorPlaceholder } from '@codemirror/view'

import './editor.css'

export interface CodeMirrorSourceEditorProps {
  value: string
  onChange: (value: string) => void
  readOnly?: boolean
  placeholder?: string
  viewRef?: MutableRefObject<EditorView | null>
}

/** Controlled CodeMirror 6 source editor used by the Markdown editor. */
export function CodeMirrorSourceEditor({
  value,
  onChange,
  readOnly = false,
  placeholder,
  viewRef,
}: CodeMirrorSourceEditorProps): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const editableCompartment = useRef(new Compartment())
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const readOnlyRef = useRef(readOnly)

  valueRef.current = value
  onChangeRef.current = onChange
  readOnlyRef.current = readOnly

  useEffect(() => {
    if (!hostRef.current) return undefined
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        ...(placeholder ? [codeMirrorPlaceholder(placeholder)] : []),
        editableCompartment.current.of(EditorView.editable.of(!readOnly)),
        EditorView.contentAttributes.of({
          'aria-label': 'Markdown 源码',
          ...(placeholder ? { 'data-placeholder': placeholder } : {}),
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || readOnlyRef.current) return
          const next = update.state.doc.toString()
          valueRef.current = next
          onChangeRef.current(next)
        }),
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    if (viewRef) viewRef.current = view
    return () => {
      if (viewRef?.current === view) viewRef.current = null
      view.destroy()
    }
  }, [placeholder, viewRef])

  useEffect(() => {
    const view = viewRef?.current
    if (!view || value === view.state.doc.toString()) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
  }, [value, viewRef])

  useEffect(() => {
    const view = viewRef?.current
    if (!view) return
    view.dispatch({ effects: editableCompartment.current.reconfigure(EditorView.editable.of(!readOnly)) })
  }, [readOnly, viewRef])

  return <div ref={hostRef} className="markdown-editor__codemirror" />
}
