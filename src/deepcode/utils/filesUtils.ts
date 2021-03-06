import * as crypto from "crypto";
import * as nodePath from "path";
import ignore from "ignore";
import { Buffer } from "buffer";
import { fs } from "mz";
import {
  HASH_ALGORITHM,
  ENCODE_TYPE,
  FILE_FORMAT,
  GITIGNORE_FILENAME,
  DCIGNORE_FILENAME,
  EXCLUDED_NAMES,
  DEFAULT_IGNORE,
  FILE_CURRENT_STATUS
} from "../constants/filesConstants";
import { ALLOWED_PAYLOAD_SIZE } from "../constants/general";
import { deepCodeMessages } from "../messages/deepCodeMessages";
import DeepCode from "../../interfaces/DeepCodeInterfaces";
import { ExclusionRule, ExclusionFilter } from "./ignoreUtils";
import { window, ProgressLocation, Progress } from "vscode";

// The file limit was hardcoded to 2mb but seems to be a function of ALLOWED_PAYLOAD_SIZE
// TODO what exactly is transmitted eventually and what is a good exact limit?
const SAFE_PAYLOAD_SIZE =  ALLOWED_PAYLOAD_SIZE / 2;   // safe size for requests

export const createFileHash = (file: string): string => {
  return crypto
    .createHash(HASH_ALGORITHM)
    .update(file)
    .digest(ENCODE_TYPE);
};

export const readFile = async (filePath: string): Promise<string> => {
  return await fs.readFile(filePath, { encoding: FILE_FORMAT });
};

export const getFileNameFromPath = (path: string): string => {
  const splittedPath = path.split("/");
  return splittedPath[splittedPath.length - 1];
};

export const createFilesHashesBundle = async (
  folderPath: string,
  serverFilesFilterList: DeepCode.AllowedServerFilterListInterface
): Promise<{ [key: string]: string }> => {
  const exclusionFilter = new ExclusionFilter();
  const rootExclusionRule = new ExclusionRule();
  rootExclusionRule.addExclusions(EXCLUDED_NAMES, "");
  exclusionFilter.addExclusionRule(rootExclusionRule);
  const {
    bundle: finalBundle,
    progress: finalProgress,
  } = await window.withProgress({
    location: ProgressLocation.Notification,
    title: deepCodeMessages.fileLoadingProgress.msg,
    cancellable: false
  }, async (progress, token) => {
    // Get a directory size overview for progress reporting
    let count = await scanFileCountFromDirectory(folderPath);

    console.log(`Checking ${count} files...`);
    progress.report({increment: 1});
    // Filter, read and hash all files
    const res = await createListOfDirFilesHashes(
      serverFilesFilterList,
      folderPath,
      folderPath,
      exclusionFilter,
      { // progress data
        filesProcessed: 0,
        totalFiles: count,
        percentDone: 0,
        progressWindow: progress
      }
    );
    progress.report({increment: 100});
    return res;
  });
  console.log(`Hashed ${Object.keys(finalBundle).length} files`);
  return finalBundle; // final window result
};

// Count all files in directory (recursively, anologously to createListOfDirFilesHashes())
const scanFileCountFromDirectory = async (
  folderPath: string
) => {
  const dirContent: string[] = await fs.readdir(folderPath);
  let subFileCount = 0;

  for (const name of dirContent) {
    const fullChildPath = nodePath.join(folderPath, name);
    if (fs.lstatSync(fullChildPath).isDirectory()) {
       subFileCount += await scanFileCountFromDirectory(fullChildPath);
    } else {
       ++subFileCount;
    }
  }
  return subFileCount;
}

// Load and hash all files in directory (recursively)
export const createListOfDirFilesHashes = async (
  serverFilesFilterList: DeepCode.AllowedServerFilterListInterface,
  folderPath: string,
  path: string = folderPath,
  exclusionFilter: ExclusionFilter,
  progress : {
    filesProcessed: number,
    totalFiles: number,
    percentDone: number,
    progressWindow: Progress<{increment: number, message: string}>
  }
) => {
  let list: { [key: string]: string } = {};
  const dirContent: string[] = await fs.readdir(path);
  const relativeDirPath = nodePath.relative(folderPath, path);
  let useDefaultIgnore: boolean = true;
  // First look for .gitignore and .dcignore files.
  for (const name of dirContent) {
    const fullChildPath = nodePath.join(path, name);
    if (name === DCIGNORE_FILENAME) useDefaultIgnore = false;
    if (name === GITIGNORE_FILENAME || name === DCIGNORE_FILENAME) {
      // We've found a ignore file.
      const exclusionRule = new ExclusionRule();
      exclusionRule.addExclusions(
        await parseGitignoreFile(fullChildPath),
        relativeDirPath
      );
      // We need to modify the exclusion rules so we have to create a copy of the exclusionFilter.
      exclusionFilter = exclusionFilter.copy();
      exclusionFilter.addExclusionRule(exclusionRule);
    }
  }
  // If no .dcignore file was found, use the standard exclusion.
  if (useDefaultIgnore) {
    const exclusionRule = new ExclusionRule();
    exclusionRule.addExclusions(DEFAULT_IGNORE, relativeDirPath);
    // We need to modify the exclusion rules so we have to create a copy of the exclusionFilter.
    exclusionFilter = exclusionFilter.copy();
    exclusionFilter.addExclusionRule(exclusionRule);
  }
  // Iterate through directory after updating exclusion rules.
  for (const name of dirContent) {
    try {
      const relativeChildPath = nodePath.join(relativeDirPath, name);
      const fullChildPath = nodePath.join(path, name);
      const fileStats = fs.statSync(fullChildPath);
      const isDirectory = fileStats.isDirectory();
      const isFile = fileStats.isFile();

      if (isFile) {
        // Update progress window on processed (non-directory) files
        ++progress.filesProcessed;
        // This check is just to throttle the reporting process
        if (progress.filesProcessed % 100 === 0) {
          const currentPercentDone =  Math.round((progress.filesProcessed / progress.totalFiles) * 100);
          const percentDoneIncrement = currentPercentDone - progress.percentDone;

          if (percentDoneIncrement > 0) {
            progress.progressWindow.report({increment: percentDoneIncrement,
                                            message: `${progress.filesProcessed} of ${progress.totalFiles} done (${currentPercentDone}%)` })
            progress.percentDone = currentPercentDone;
          }
        }
      }

      //console.log(`relativeChildPath ${relativeChildPath} excluded --> `, exclusionFilter.excludes(relativeChildPath));
      if (exclusionFilter.excludes(relativeChildPath)) {
        continue;
      }

      if (isFile) {
        if (!acceptFileToBundle(name, serverFilesFilterList)) continue;
      
        // Exclude files which are too large to be transferred via http. There is currently no
        // way to process them in multiple chunks
        const fileContentSize = fileStats.size;
        if (fileContentSize > SAFE_PAYLOAD_SIZE) {
          console.log("Excluding file " + fullChildPath + " from processing: size " +
                      fileContentSize + " exceeds payload size limit " + SAFE_PAYLOAD_SIZE);
          continue;
        }
        const filePath = path.split(folderPath)[1];
        const fileContent = await readFile(fullChildPath);
        list[`${filePath}/${name}`] = createFileHash(fileContent);
      }

      if (isDirectory) {
        const {
          bundle: subBundle,
          progress: subProgress,
        } = await createListOfDirFilesHashes(
          serverFilesFilterList,
          folderPath,
          `${path}/${name}`,
          exclusionFilter,
          progress
        );
        progress = subProgress;
        for (let key of Object.keys(subBundle)) {
          progress.filesProcessed
          list[key] = subBundle[key];
        }
      }
    } catch (err) {
      continue;
    }
  }
  return {
    bundle: list,
    progress,
  };
  
};

export const acceptFileToBundle = (
  name: string,
  serverFilesFilterList: DeepCode.AllowedServerFilterListInterface
): boolean => {
  name = nodePath.basename(name);
  if (
    (serverFilesFilterList.configFiles &&
      serverFilesFilterList.configFiles.includes(name)) ||
    (serverFilesFilterList.extensions &&
      serverFilesFilterList.extensions.includes(nodePath.extname(name)))
  ) {
    return true;
  }
  return false;
};

export const isFileChangingBundle = (
  name: string,
): boolean => {
  name = nodePath.basename(name);
  if (name === GITIGNORE_FILENAME || name === DCIGNORE_FILENAME) {
    return true;
  }
  return false;
};

export const parseGitignoreFile = async (
  filePath: string
): Promise<string[]> => {
  let gitignoreContent: string | string[] = await readFile(filePath);
  gitignoreContent = gitignoreContent.split("\n").filter(file => !!file);
  return gitignoreContent;
};

export const createMissingFilesPayloadUtil = async (
  missingFiles: Array<string>,
  currentWorkspacePath: string
): Promise<Array<DeepCode.PayloadMissingFileInterface>> => {
  const result: {
    fileHash: string;
    filePath: string;
    fileContent: string;
  }[] = [];
  for await (const file of missingFiles) {
    if (currentWorkspacePath) {
      const filePath = `${currentWorkspacePath}${file}`;
      const fileContent = await readFile(filePath);
      result.push({
        fileHash: createFileHash(fileContent),
        filePath,
        fileContent
      });
    }
  }
  return result;
};

export const compareFileChanges = async (
  filePath: string,
  currentWorkspacePath: string,
  currentWorkspaceFilesBundle: { [key: string]: string } | null
): Promise<{ [key: string]: string }> => {
  const filePathInsideBundle = filePath.split(currentWorkspacePath)[1];
  const response: { [key: string]: string } = {
    fileHash: "",
    filePath: filePathInsideBundle,
    status: ""
  };
  const { same, modified, created, deleted } = FILE_CURRENT_STATUS;
  try {
    const fileHash = await createFileHash(await readFile(filePath));
    response.fileHash = fileHash;
    if (currentWorkspaceFilesBundle) {
      if (currentWorkspaceFilesBundle[filePathInsideBundle]) {
        response.status =
          fileHash === currentWorkspaceFilesBundle[filePathInsideBundle]
            ? same
            : modified;
      } else {
        response.status = created;
      }
    }
  } catch (err) {
    if (
      currentWorkspaceFilesBundle &&
      currentWorkspaceFilesBundle[filePathInsideBundle]
    ) {
      response.status = deleted;
      return response;
    }
    throw err;
  }
  return response;
};

export const processServerFilesFilterList = (
  filterList: DeepCode.AllowedServerFilterListInterface
): DeepCode.AllowedServerFilterListInterface => {
  const { configFiles } = filterList;
  if (configFiles) {
    const processedConfigFiles = configFiles.map((item: string) =>
      item.slice(1)
    );
    return { ...filterList, configFiles: processedConfigFiles };
  }
  return filterList;
};

export const processPayloadSize = (
  payload: Array<DeepCode.PayloadMissingFileInterface>
): {
  chunks: boolean;
  payload:
    | Array<DeepCode.PayloadMissingFileInterface>
    | Array<Array<DeepCode.PayloadMissingFileInterface>>;
} => {
  const buffer = Buffer.from(JSON.stringify(payload));
  const payloadByteSize = Buffer.byteLength(buffer);

  if (payloadByteSize < ALLOWED_PAYLOAD_SIZE) {
    return { chunks: false, payload };
  }
  const chunkedPayload = splitPayloadIntoChunks(payload, payloadByteSize);
  return chunkedPayload;
};

export const splitPayloadIntoChunks = (
  payload: {
    fileHash: string;
    filePath: string;
    fileContent: string;
  }[],
  payloadByteSize: number
) => {
  const chunkedPayload = [];

  // Break input array of files
  //     [  {hash1, content1},    {hash2, content2},   ...]
  // into array of chunks limited by an upper size bound to avoid http 413 errors
  //     [  [{hash1, content1}],  [{hash2, content2}, {hash3, content3}]  ]
  let currentChunkSize = 0;
  for (let i = 0; i < payload.length; i++) {
    const currentChunkElement = payload[i];
    const currentWorstCaseChunkElementSize = Buffer.byteLength(Buffer.from(JSON.stringify(currentChunkElement)));
    const lastChunk = chunkedPayload[chunkedPayload.length - 1];

    if (!lastChunk || currentChunkSize + currentWorstCaseChunkElementSize > SAFE_PAYLOAD_SIZE) {
      // Start a new chunk
      chunkedPayload.push([payload[i]]);
      currentChunkSize = currentWorstCaseChunkElementSize;
    } else {
      // Append item to current chunk
      lastChunk.push(payload[i]);
      currentChunkSize += currentWorstCaseChunkElementSize;
    }
  }

  return { chunks: true, payload: chunkedPayload };
};
