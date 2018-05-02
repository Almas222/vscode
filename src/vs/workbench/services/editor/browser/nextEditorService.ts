/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IEditorInput, IResourceInput, IUntitledResourceInput, IResourceDiffInput, IResourceSideBySideInput, IEditor, ITextEditorOptions, IEditorOptions } from 'vs/platform/editor/common/editor';
import { GroupIdentifier, IFileEditorInput, IEditorInputFactoryRegistry, Extensions as EditorExtensions, IFileInputFactory, EditorInput, SideBySideEditorInput, EditorOptions, TextEditorOptions } from 'vs/workbench/common/editor';
import { ResourceEditorInput } from 'vs/workbench/common/editor/resourceEditorInput';
import { DataUriEditorInput } from 'vs/workbench/common/editor/dataUriEditorInput';
import { Registry } from 'vs/platform/registry/common/platform';
import { ResourceMap } from 'vs/base/common/map';
import { IUntitledEditorService } from 'vs/workbench/services/untitled/common/untitledEditorService';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { IFileService } from 'vs/platform/files/common/files';
import { Schemas } from 'vs/base/common/network';
import { getPathLabel } from 'vs/base/common/labels';
import { once } from 'vs/base/common/event';
import URI from 'vs/base/common/uri';
import { basename } from 'vs/base/common/paths';
import { DiffEditorInput } from 'vs/workbench/common/editor/diffEditorInput';
import { localize } from 'vs/nls';
import { TPromise } from 'vs/base/common/winjs.base';
import { INextEditorGroupsService, INextEditorGroup, Direction } from 'vs/workbench/services/editor/common/nextEditorGroupsService';
import { INextEditorService, IResourceEditor, SIDE_BY_SIDE, SIDE_BY_SIDE_VALUE } from 'vs/workbench/services/editor/common/nextEditorService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';

type ICachedEditorInput = ResourceEditorInput | IFileEditorInput | DataUriEditorInput;

export class NextEditorService implements INextEditorService {

	_serviceBrand: any;

	private static CACHE: ResourceMap<ICachedEditorInput> = new ResourceMap<ICachedEditorInput>();

	private fileInputFactory: IFileInputFactory;

	constructor(
		@INextEditorGroupsService private nextEditorGroupsService: INextEditorGroupsService,
		@IUntitledEditorService private untitledEditorService: IUntitledEditorService,
		@IWorkspaceContextService private workspaceContextService: IWorkspaceContextService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IFileService private fileService: IFileService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		this.fileInputFactory = Registry.as<IEditorInputFactoryRegistry>(EditorExtensions.EditorInputFactories).getFileInputFactory();
	}

	openEditor(editor: IEditorInput, options?: IEditorOptions, group?: GroupIdentifier | SIDE_BY_SIDE): Thenable<IEditor>;
	openEditor(editor: IResourceEditor, group?: GroupIdentifier | SIDE_BY_SIDE): Thenable<IEditor>;
	openEditor(editor: IEditorInput | IResourceEditor, optionsOrGroup?: IEditorOptions | GroupIdentifier, group?: GroupIdentifier): Thenable<IEditor> {

		// Typed Editor Support
		if (editor instanceof EditorInput) {
			return this.doOpenEditor(editor, this.toOptions(optionsOrGroup as IEditorOptions), group);
		}

		// Throw error for well known foreign resources (such as a http link) (TODO@ben remove me after this has been adopted)
		const resourceInput = <IResourceInput>editor;
		if (resourceInput.resource instanceof URI) {
			const schema = resourceInput.resource.scheme;
			if (schema === Schemas.http || schema === Schemas.https) {
				return TPromise.wrapError(new Error('Invalid scheme http/https to open resource as editor. Use IOpenerService instead.'));
			}
		}

		// Untyped Text Editor Support
		const textInput = <IResourceEditor>editor;
		const typedInput = this.createInput(textInput);
		if (typedInput) {
			return this.doOpenEditor(typedInput, TextEditorOptions.from(textInput), optionsOrGroup as GroupIdentifier);
		}

		return TPromise.wrap<IEditor>(null);
	}

	private doOpenEditor(input: IEditorInput, options?: EditorOptions, group?: GroupIdentifier | SIDE_BY_SIDE): Thenable<IEditor> {
		let targetGroup: INextEditorGroup;

		// Group: Side by Side
		if (group === SIDE_BY_SIDE_VALUE) {
			targetGroup = this.nextEditorGroupsService.addGroup(this.nextEditorGroupsService.activeGroup, Direction.RIGHT);
		}

		// Group: Specific Group
		else if (typeof group === 'number') {
			targetGroup = this.nextEditorGroupsService.getGroup(group);
		}

		// Group: Unspecified without a specific index to open
		else if (!options || typeof options.index !== 'number') {
			const groupsByLastActive = this.nextEditorGroupsService.getGroups(true);

			// Respect option to reveal an editor if it is already visible in any group
			if (options && options.revealIfVisible) {
				for (let i = 0; i < groupsByLastActive.length; i++) {
					const group = groupsByLastActive[i];
					if (input.matches(group.activeEditor)) {
						targetGroup = group;
						break;
					}
				}
			}

			// Respect option to reveal an editor if it is open (not necessarily visible)
			if ((options && options.revealIfOpened) || this.configurationService.getValue<boolean>('workbench.editor.revealIfOpen')) {
				for (let i = 0; i < groupsByLastActive.length; i++) {
					const group = groupsByLastActive[i];
					if (group.isOpened(input)) {
						targetGroup = group;
						break;
					}
				}
			}
		}

		// Fallback to active group if target not valid
		if (!targetGroup) {
			targetGroup = this.nextEditorGroupsService.activeGroup;
		}

		return targetGroup.openEditor(input, options).then(() => targetGroup.activeControl);
	}

	private toOptions(options?: IEditorOptions | EditorOptions): EditorOptions {
		if (!options || options instanceof EditorOptions) {
			return options as EditorOptions;
		}

		const textOptions: ITextEditorOptions = options;
		if (!!textOptions.selection) {
			return TextEditorOptions.create(options);
		}

		return EditorOptions.create(options);
	}

	createInput(input: IEditorInput | IResourceEditor): EditorInput {

		// Typed Editor Input Support
		if (input instanceof EditorInput) {
			return input;
		}

		// Side by Side Support
		const resourceSideBySideInput = <IResourceSideBySideInput>input;
		if (resourceSideBySideInput.masterResource && resourceSideBySideInput.detailResource) {
			const masterInput = this.createInput({ resource: resourceSideBySideInput.masterResource });
			const detailInput = this.createInput({ resource: resourceSideBySideInput.detailResource });

			return new SideBySideEditorInput(
				resourceSideBySideInput.label || masterInput.getName(),
				typeof resourceSideBySideInput.description === 'string' ? resourceSideBySideInput.description : masterInput.getDescription(),
				detailInput,
				masterInput
			);
		}

		// Diff Editor Support
		const resourceDiffInput = <IResourceDiffInput>input;
		if (resourceDiffInput.leftResource && resourceDiffInput.rightResource) {
			const leftInput = this.createInput({ resource: resourceDiffInput.leftResource });
			const rightInput = this.createInput({ resource: resourceDiffInput.rightResource });
			const label = resourceDiffInput.label || localize('compareLabels', "{0} ↔ {1}", this.toDiffLabel(leftInput, this.workspaceContextService, this.environmentService), this.toDiffLabel(rightInput, this.workspaceContextService, this.environmentService));

			return new DiffEditorInput(label, resourceDiffInput.description, leftInput, rightInput);
		}

		// Untitled file support
		const untitledInput = <IUntitledResourceInput>input;
		if (!untitledInput.resource || typeof untitledInput.filePath === 'string' || (untitledInput.resource instanceof URI && untitledInput.resource.scheme === Schemas.untitled)) {
			return this.untitledEditorService.createOrGet(
				untitledInput.filePath ? URI.file(untitledInput.filePath) : untitledInput.resource,
				untitledInput.language,
				untitledInput.contents,
				untitledInput.encoding
			);
		}

		// Resource Editor Support
		const resourceInput = <IResourceInput>input;
		if (resourceInput.resource instanceof URI) {
			let label = resourceInput.label;
			if (!label && resourceInput.resource.scheme !== Schemas.data) {
				label = basename(resourceInput.resource.fsPath); // derive the label from the path (but not for data URIs)
			}

			return this.createOrGet(resourceInput.resource, this.instantiationService, label, resourceInput.description, resourceInput.encoding) as EditorInput;
		}

		return null;
	}

	private createOrGet(resource: URI, instantiationService: IInstantiationService, label: string, description: string, encoding?: string): ICachedEditorInput {
		if (NextEditorService.CACHE.has(resource)) {
			const input = NextEditorService.CACHE.get(resource);
			if (input instanceof ResourceEditorInput) {
				input.setName(label);
				input.setDescription(description);
			} else if (!(input instanceof DataUriEditorInput)) {
				input.setPreferredEncoding(encoding);
			}

			return input;
		}

		let input: ICachedEditorInput;

		// File
		if (this.fileService.canHandleResource(resource)) {
			input = this.fileInputFactory.createFileInput(resource, encoding, instantiationService);
		}

		// Data URI
		else if (resource.scheme === Schemas.data) {
			input = instantiationService.createInstance(DataUriEditorInput, label, description, resource);
		}

		// Resource
		else {
			input = instantiationService.createInstance(ResourceEditorInput, label, description, resource);
		}

		NextEditorService.CACHE.set(resource, input);
		once(input.onDispose)(() => {
			NextEditorService.CACHE.delete(resource);
		});

		return input;
	}

	private toDiffLabel(input: EditorInput, context: IWorkspaceContextService, environment: IEnvironmentService): string {
		const res = input.getResource();

		// Do not try to extract any paths from simple untitled editors
		if (res.scheme === Schemas.untitled && !this.untitledEditorService.hasAssociatedFilePath(res)) {
			return input.getName();
		}

		// Otherwise: for diff labels prefer to see the path as part of the label
		return getPathLabel(res.fsPath, context, environment);
	}
}