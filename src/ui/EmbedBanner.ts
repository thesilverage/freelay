"use strict";

export class EmbedBanner {
	text: string;
	onClick: () => Promise<boolean>;

	constructor(
		private containerEl: Element | null,
		private before: Element | null,
		text: string,
		onClick: () => Promise<boolean>,
	) {
		this.text = text;
		this.onClick = onClick;
		this.display();
	}

	display() {
		if (!this.containerEl || !this.before) return true;
		const leafContentEl = this.containerEl;
		const contentEl = this.before;

		if (!leafContentEl) {
			return;
		}

		// container to enable easy removal of the banner
		let bannerBox = leafContentEl.querySelector(".freelay-banner-box");
		if (!bannerBox) {
			bannerBox = leafContentEl.createDiv();
			bannerBox.classList.add("freelay-banner-box");
			leafContentEl.insertBefore(bannerBox, contentEl);
		}

		let banner = leafContentEl.querySelector(".freelay-banner");
		if (!banner) {
			banner = leafContentEl.createDiv();
			banner.classList.add("freelay-banner");
			const span = banner.createSpan();
			span.setText(this.text);
			banner.appendChild(span);
			bannerBox.appendChild(banner);
			const onClick = async () => {
				const destroy = await this.onClick();
				if (destroy) {
					this.destroy();
				}
			};
			banner.addEventListener("click", () => void onClick());
		}
		return true;
	}

	destroy() {
		const leafContentEl = this.containerEl;
		if (!leafContentEl) {
			return;
		}
		const bannerBox = leafContentEl.querySelector(".freelay-banner-box");
		if (bannerBox) {
			bannerBox.replaceChildren();
		}
		return true;
	}
}
