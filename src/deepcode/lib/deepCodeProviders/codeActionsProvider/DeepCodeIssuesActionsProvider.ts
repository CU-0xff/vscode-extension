import * as vscode from "vscode";
import {
  findIssueWithRange,
  ignoreIssueCommentText,
  extractIssueNameOutOfId
} from "../../../utils/analysisUtils";
import {
  IGNORE_ISSUE_ACTION_NAME,
  FILE_IGNORE_ACTION_NAME,
  IGNORE_ISSUE_BASE_COMMENT_TEXT,
  COMMUNITY_EXPORT_SUGGESTION_ACTION_NAME
} from "../../../constants/analysis";
import {
  DEEPCODE_IGNORE_ISSUES_COMMAND,
  VSCODE_ADD_COMMENT_COMMAND,
  DEEPCODE_COMMUNITY_EXPORT_SUGGESTION_COMMAND
} from "../../../constants/commands";

export class DeepCodeIssuesActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.QuickFix
  ];

  private issuesList: vscode.DiagnosticCollection | undefined;
  private findSuggestionId: Function;

  constructor(
    issuesList: vscode.DiagnosticCollection | undefined,
    callbacks: { [key: string]: Function }
  ) {
    this.issuesList = issuesList;
    this.registerIgnoreIssuesCommand();
    this.registerCommunityExportSuggestionCommand();
    this.findSuggestionId = callbacks.findSuggestionId;
  }

  // Community Addition
  private registerCommunityExportSuggestionCommand() {
    vscode.commands.registerCommand(
      DEEPCODE_COMMUNITY_EXPORT_SUGGESTION_COMMAND,
       ({
        currentEditor,
        issueText,
        matchedIssue
      }: {
        currentEditor: vscode.TextEditor;
        matchedIssue: vscode.Diagnostic;
        issueText: string;
      }): void => { 
        return; }
    )
  }

  private registerIgnoreIssuesCommand() {
    vscode.commands.registerCommand(
      DEEPCODE_IGNORE_ISSUES_COMMAND,
      ({
        currentEditor,
        issueText,
        matchedIssue
      }: {
        currentEditor: vscode.TextEditor;
        matchedIssue: vscode.Diagnostic;
        issueText: string;
      }): void => {
        const editor: vscode.TextEditor | undefined =
          currentEditor || vscode.window.activeTextEditor;
        if (!editor || !issueText || !matchedIssue) {
          return;
        }
        const lineOffset = 1;
        const symbolIndexToInsert = editor.document.lineAt(
          matchedIssue.range.start.line
        ).firstNonWhitespaceCharacterIndex;
        const issuePosition = new vscode.Position(
          matchedIssue.range.start.line,
          symbolIndexToInsert
        );
        const prevLinePosition = new vscode.Position(
          issuePosition.line - lineOffset,
          issuePosition.character
        );

        const {
          text: prevLineText,
          range: prevLineTextRange
        }: {
          text: string;
          range: vscode.Range;
        } = editor.document.lineAt(prevLinePosition);
        const deepCodeCommentAlreadyExists = prevLineText.includes(
          IGNORE_ISSUE_BASE_COMMENT_TEXT
        );

        if (deepCodeCommentAlreadyExists) {
          // if deepcode ignore of issue already exists, paste next comment in same line after existing comment
          editor.edit((e: vscode.TextEditorEdit) =>
            e.insert(
              new vscode.Position(
                prevLinePosition.line,
                prevLineTextRange.end.character
              ),
              `, ${issueText}`
            )
          );
        } else {
          editor.edit((e: vscode.TextEditorEdit) =>
            e.insert(
              issuePosition,
              this.addSpacesToText(`${issueText}\n`, symbolIndexToInsert)
            )
          );
        }
        editor.selections = [
          new vscode.Selection(issuePosition, issuePosition)
        ];
        if (!deepCodeCommentAlreadyExists) {
          vscode.commands.executeCommand(VSCODE_ADD_COMMENT_COMMAND);
        }
      }
    );
  }

  private addSpacesToText(text: string = "", spacesCount: number = 0): string {
    if (!spacesCount) {
      return text;
    }
    while (spacesCount) {
      text += ` `;
      spacesCount--;
    }
    return text;
  }

  private createExportIssueAction({
    document,
    matchedIssue,
    isFileIgnore
  }: {
    document: vscode.TextDocument;
    matchedIssue: vscode.Diagnostic;
    isFileIgnore?: boolean;
  }): vscode.CodeAction {
    const exportIssueAction = new vscode.CodeAction(
      COMMUNITY_EXPORT_SUGGESTION_ACTION_NAME,
      DeepCodeIssuesActionProvider.providedCodeActionKinds[0]
    );
   const issueFullId: string = this.findSuggestionId(
      matchedIssue.message,
      document.uri.fsPath
    );
    const issueNameForComment: string = extractIssueNameOutOfId(issueFullId);
    const issueText: string = ignoreIssueCommentText(
      issueNameForComment,
      isFileIgnore
    );

    exportIssueAction.command = {
      command: DEEPCODE_COMMUNITY_EXPORT_SUGGESTION_COMMAND,
      title: DEEPCODE_COMMUNITY_EXPORT_SUGGESTION_COMMAND,
      arguments: [{ issueText, matchedIssue }]
    };

    return exportIssueAction;
  }

  
  private createIgnoreIssueAction({
    document,
    matchedIssue,
    isFileIgnore
  }: {
    document: vscode.TextDocument;
    matchedIssue: vscode.Diagnostic;
    isFileIgnore?: boolean;
  }): vscode.CodeAction {
    const ignoreIssueAction = new vscode.CodeAction(
      isFileIgnore ? FILE_IGNORE_ACTION_NAME : IGNORE_ISSUE_ACTION_NAME,
      DeepCodeIssuesActionProvider.providedCodeActionKinds[0]
    );

    const issueFullId: string = this.findSuggestionId(
      matchedIssue.message,
      document.uri.fsPath
    );
    const issueNameForComment: string = extractIssueNameOutOfId(issueFullId);
    const issueText: string = ignoreIssueCommentText(
      issueNameForComment,
      isFileIgnore
    );

    ignoreIssueAction.command = {
      command: DEEPCODE_IGNORE_ISSUES_COMMAND,
      title: DEEPCODE_IGNORE_ISSUES_COMMAND,
      arguments: [{ issueText, matchedIssue }]
    };

    return ignoreIssueAction;
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    clickedRange: vscode.Range
  ): vscode.CodeAction[] | undefined {
    if (!this.issuesList || !this.issuesList.has(document.uri)) {
      return;
    }
    const fileIssues = this.issuesList && this.issuesList.get(document.uri);
    const matchedIssue = findIssueWithRange(clickedRange, fileIssues);
    if (matchedIssue) {
      const codeActionParams = { document, matchedIssue };
      const ignoreIssueAction = this.createIgnoreIssueAction(codeActionParams);
      const fileIgnoreIssueAction = this.createIgnoreIssueAction({
        ...codeActionParams,
        isFileIgnore: true
      });
      const exportIssueAction = this.createExportIssueAction(codeActionParams);

      // returns list of actions, all new actions should be added to this list
      return [ignoreIssueAction, fileIgnoreIssueAction, exportIssueAction];
    }
  }
}

// disposable provider
export class DisposableCodeActionsProvider implements vscode.Disposable {
  private disposableProvider: vscode.Disposable | undefined;
  constructor(
    deepcodeReview: vscode.DiagnosticCollection | undefined,
    callbacks: { [key: string]: Function }
  ) {
    this.registerProvider(deepcodeReview, callbacks);
  }

  private registerProvider(
    deepcodeReview: vscode.DiagnosticCollection | undefined,
    callbacks: { [key: string]: Function }
  ) {
    this.disposableProvider = vscode.languages.registerCodeActionsProvider(
      { scheme: "file", language: "*" },
      new DeepCodeIssuesActionProvider(deepcodeReview, callbacks),
      {
        providedCodeActionKinds:
          DeepCodeIssuesActionProvider.providedCodeActionKinds
      }
    );
  }

  public dispose() {
    if (this.disposableProvider) {
      this.disposableProvider.dispose();
    }
  }
}
